// Fixed typed filesystem worker. This is not a command runner or a remote API.
// Trusted composition supplies roots/protected paths; MCP callers never do.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <ktmw32.h>
#include <wincrypt.h>
#include <aclapi.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>
#include <thread>
#include <io.h>
#include <fcntl.h>
#pragma comment(lib,"Advapi32.lib")
#pragma comment(lib,"KtmW32.lib")
#pragma comment(lib,"Crypt32.lib")
#pragma comment(lib,"windowsapp.lib")

namespace {
using namespace winrt::Windows::Data::Json;
constexpr size_t LIMIT=1024*1024;
constexpr DWORD GIT_CHUNK=256*1024;
constexpr ULONGLONG GIT_PACK_MAX=64ULL*1024*1024;
enum class Outcome {NoChange,Unknown,Applied};
Outcome outcome=Outcome::NoChange;
struct Failure {};
[[noreturn]] void deny() { throw Failure{}; }
void require(bool value) {if(!value) deny();}
struct Handle {
  HANDLE value=INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE v=INVALID_HANDLE_VALUE):value(v) {}
  ~Handle() {if(value!=INVALID_HANDLE_VALUE) CloseHandle(value);}
  Handle(const Handle&)=delete;
};
struct Transaction {
  HANDLE value=INVALID_HANDLE_VALUE;
  bool committed=false;
  Transaction():value(CreateTransaction(nullptr,nullptr,0,0,0,5000,nullptr)) {require(value!=INVALID_HANDLE_VALUE);}
  ~Transaction() {
    if(!committed) outcome=RollbackTransaction(value)?Outcome::NoChange:Outcome::Unknown;
    CloseHandle(value);
  }
  void commit() {
    outcome=Outcome::Unknown;
    require(CommitTransaction(value));committed=true;outcome=Outcome::Applied;
  }
  Transaction(const Transaction&)=delete;
};
using NtCreate=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
auto ntCreate=reinterpret_cast<NtCreate>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtCreateFile"));
std::wstring lower(std::wstring text) { std::transform(text.begin(),text.end(),text.begin(),[](wchar_t c){return static_cast<wchar_t>(towlower(c));});return text; }
bool within(const std::wstring& root,const std::wstring& path) {return path==root||(path.size()>root.size()&&path.compare(0,root.size(),root)==0&&(root.back()==L'\\'||path[root.size()]==L'\\'));}
std::wstring identity(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(handle,&info));
  return std::to_wstring(info.dwVolumeSerialNumber)+L":"+std::to_wstring((static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow);
}
void ordinary(HANDLE handle,bool directory) {
  BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(handle,&info));
  require(!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
  require(directory?bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY):!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&info.nNumberOfLinks==1);
}
std::wstring canonical(HANDLE handle) {
  std::vector<wchar_t> buffer(32768);
  DWORD count=GetFinalPathNameByHandleW(handle,buffer.data(),static_cast<DWORD>(buffer.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  require(count>0&&count<buffer.size());return std::wstring(buffer.data(),count);
}
std::vector<std::wstring> segments(const std::wstring& text,bool allowRoot=false) {
  if(allowRoot&&text==L".") return {};
  require(!text.empty()&&text.size()<=2048);
  std::vector<std::wstring> result;size_t start=0;
  while(start<text.size()) {
    size_t end=text.find(L'/',start);auto part=text.substr(start,end==std::wstring::npos?end:end-start);
    require(!part.empty()&&part!=L"."&&part!=L".."&&part.back()!=L'.'&&part.back()!=L' ');
    for(wchar_t c:part) require(c>=32&&c!=127&&c!=L'\\'&&c!=L':'&&c!=L'\0'&&c!=L'<'&&c!=L'>'&&c!=L'"'&&c!=L'|'&&c!=L'?'&&c!=L'*');
    auto device=lower(part.substr(0,part.find(L'.')));
    require(device!=L"con"&&device!=L"prn"&&device!=L"aux"&&device!=L"nul"&&device!=L"conin$"&&device!=L"conout$");
    require(!(device.size()==4&&(device.substr(0,3)==L"com"||device.substr(0,3)==L"lpt")&&device[3]>=L'0'&&device[3]<=L'9'));
    result.push_back(part);require(result.size()<=60);
    if(end==std::wstring::npos) break;
    start=end+1;require(start<text.size());
  }
  return result;
}
std::unique_ptr<Handle> relativeOpen(HANDLE parent,const std::wstring& name,bool directory) {
  UNICODE_STRING str{};str.Buffer=const_cast<PWSTR>(name.c_str());str.Length=static_cast<USHORT>(name.size()*sizeof(wchar_t));str.MaximumLength=str.Length;
  OBJECT_ATTRIBUTES object{};InitializeObjectAttributes(&object,&str,OBJ_CASE_INSENSITIVE,parent,nullptr);
  IO_STATUS_BLOCK io{};auto result=std::make_unique<Handle>();
  NTSTATUS status=ntCreate(&result->value,SYNCHRONIZE|FILE_READ_ATTRIBUTES|(directory?FILE_LIST_DIRECTORY:FILE_READ_DATA),&object,&io,nullptr,FILE_ATTRIBUTE_NORMAL,
    directory?FILE_SHARE_READ|FILE_SHARE_WRITE:FILE_SHARE_READ,FILE_OPEN,FILE_SYNCHRONOUS_IO_NONALERT|FILE_OPEN_REPARSE_POINT|(directory?FILE_DIRECTORY_FILE:FILE_NON_DIRECTORY_FILE),nullptr,0);
  require(status>=0);ordinary(result->value,directory);return result;
}
bool gitPackPath(const std::vector<std::wstring>& parts) {
  if(parts.size()<4) return false;
  size_t start=parts.size()-4;
  if(lower(parts[start])!=L".git"||lower(parts[start+1])!=L"objects"||lower(parts[start+2])!=L"pack") return false;
  auto file=lower(parts.back());
  if(file.size()!=50&&file.size()!=49) return false;
  if(file.substr(0,5)!=L"pack-") return false;
  for(size_t i=5;i<45;i++) {
    wchar_t c=file[i];if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f'))) return false;
  }
  if(file.size()<45) return false;
  auto extension=file.substr(45);
  return extension==L".pack"||extension==L".idx"||extension==L".rev";
}
std::wstring gitStamp(const BY_HANDLE_FILE_INFORMATION& info) {
  ULONGLONG fileIndex=(static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow;
  ULONGLONG size=(static_cast<ULONGLONG>(info.nFileSizeHigh)<<32)|info.nFileSizeLow;
  return std::to_wstring(info.dwVolumeSerialNumber)+L":"+std::to_wstring(fileIndex)+
    L":"+std::to_wstring(size)+L":"+std::to_wstring(info.ftLastWriteTime.dwHighDateTime)+
    L":"+std::to_wstring(info.ftLastWriteTime.dwLowDateTime);
}
std::vector<BYTE> readBytes(HANDLE handle) {
  LARGE_INTEGER size{};require(GetFileSizeEx(handle,&size)&&size.QuadPart>=0&&size.QuadPart<=static_cast<LONGLONG>(LIMIT));
  std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));DWORD count=0;
  require(bytes.empty()||(ReadFile(handle,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size()));return bytes;
}
std::wstring encode(const std::vector<BYTE>& bytes) {
  if(bytes.empty()) return L"";
  DWORD size=0;require(CryptBinaryToStringW(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&size));
  std::vector<wchar_t> text(size);require(CryptBinaryToStringW(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,text.data(),&size));
  return std::wstring(text.data());
}
std::vector<BYTE> decode(const std::wstring& text) {
  require(text.size()<=((LIMIT+2)/3)*4);if(text.empty()) return {};
  DWORD size=0;require(CryptStringToBinaryW(text.c_str(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64,nullptr,&size,nullptr,nullptr)&&size<=LIMIT);
  std::vector<BYTE> bytes(size);require(CryptStringToBinaryW(text.c_str(),static_cast<DWORD>(text.size()),CRYPT_STRING_BASE64,bytes.data(),&size,nullptr,nullptr));
  require(encode(bytes)==text);return bytes;
}
JsonObject success() {JsonObject out;out.Insert(L"ok",JsonValue::CreateBooleanValue(true));return out;}
std::wstring string(const JsonObject& request,const wchar_t* key) {return std::wstring(request.GetNamedString(key));}
void strict(const JsonObject& request,const std::set<std::wstring>& extra) {
  for(const auto& item:request) {
    auto key=std::wstring(item.Key());
    require(key==L"operation"||key==L"root"||key==L"path"||key==L"protectedPaths"||key==L"protectedMutationPaths"||extra.count(key));
  }
}

class Root {
  std::vector<std::unique_ptr<Handle>> pins;
  std::vector<std::wstring> protectedPaths;
  std::set<std::wstring> protectedIdentities;
  std::vector<std::wstring> mutationPaths;
  std::set<std::wstring> mutationIdentities;
public:
  explicit Root(const JsonObject& request,bool internalRecovery=false) {
    auto input=string(request,L"root");require(input.size()>=3&&iswalpha(input[0])&&input[1]==L':'&&input[2]==L'\\'&&input.size()<32700);
    std::replace(input.begin(),input.end(),L'\\',L'/');
    auto drive=input.substr(0,2)+L"\\";
    auto root=std::make_unique<Handle>(CreateFileW(drive.c_str(),FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    require(root->value!=INVALID_HANDLE_VALUE);ordinary(root->value,true);pins.push_back(std::move(root));
    for(auto& part:segments(input.size()==3?L".":input.substr(3),true)) pins.push_back(relativeOpen(pins.back()->value,part,true));
    for(auto value:request.GetNamedArray(L"protectedPaths")) {
      auto path=std::wstring(value.GetString());require(path.size()>=3&&path.size()<32700);
      auto absolute=std::filesystem::absolute(path).wstring();
      Handle protect(CreateFileW(absolute.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      if(protect.value!=INVALID_HANDLE_VALUE) {
        auto resolved=lower(canonical(protect.value));
        if(internalRecovery&&within(resolved,lower(canonical(pins.back()->value)))) continue;
        protectedIdentities.insert(identity(protect.value));protectedPaths.push_back(resolved);
      }
      else {require(GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND);protectedPaths.push_back(lower(L"\\\\?\\"+absolute));}
    }
    if(request.HasKey(L"protectedMutationPaths")) for(auto value:request.GetNamedArray(L"protectedMutationPaths")) {
      auto path=std::wstring(value.GetString());require(path.size()>=3&&path.size()<32700);
      auto absolute=std::filesystem::absolute(path).wstring();
      Handle protect(CreateFileW(absolute.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      if(protect.value!=INVALID_HANDLE_VALUE) {mutationIdentities.insert(identity(protect.value));mutationPaths.push_back(lower(canonical(protect.value)));}
      else {require(GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND);mutationPaths.push_back(lower(L"\\\\?\\"+absolute));}
    }
    check(pins.back()->value);
  }
  HANDLE handle() const {return pins.back()->value;}
  void check(HANDLE h,bool mutation=false) const {
    auto path=lower(canonical(h));require(!protectedIdentities.count(identity(h)));
    for(const auto& protect:protectedPaths) require(!within(protect,path));
    if(mutation) {
      require(!mutationIdentities.count(identity(h)));
      for(const auto& protect:mutationPaths) require(!within(protect,path));
    }
  }
  std::vector<std::unique_ptr<Handle>> parents(const std::vector<std::wstring>& parts) const {
    std::vector<std::unique_ptr<Handle>> result;
    for(size_t i=0;i+1<parts.size();i++) {
      result.push_back(relativeOpen(result.empty()?handle():result.back()->value,parts[i],true));check(result.back()->value);
    }
    return result;
  }
  std::wstring path(HANDLE parent,const std::wstring& leaf,bool mutation=false) const {
    auto value=canonical(parent)+L"\\"+leaf;auto normalized=lower(value);
    for(const auto& protect:protectedPaths) require(!within(protect,normalized)&&(!mutation||!within(normalized,protect)));
    if(mutation) for(const auto& protect:mutationPaths) require(!within(protect,normalized)&&!within(normalized,protect));
    return value;
  }
};

// A bounded observed manifest, never a directory timestamp approximation.
// Descendants are pinned no-follow during validation; they must close before
// Windows permits directory rename. Membership changes in that window are not
// a whole-tree compare-and-swap; the identity-bound rename preserves the actual
// complete tree and never replaces a destination.
struct Tree {
  std::vector<std::unique_ptr<Handle>> pins;
  HCRYPTPROV provider=0;
  HCRYPTHASH hash=0;
  size_t entries=0;
  ULONGLONG total=0;
  Tree() {require(CryptAcquireContextW(&provider,nullptr,nullptr,PROV_RSA_AES,CRYPT_VERIFYCONTEXT));require(CryptCreateHash(provider,CALG_SHA_256,0,0,&hash));}
  ~Tree() {if(hash) CryptDestroyHash(hash);if(provider) CryptReleaseContext(provider,0);}
  void add(const std::wstring& value) {
    auto bytes=static_cast<DWORD>(value.size()*sizeof(wchar_t));
    require(CryptHashData(hash,reinterpret_cast<const BYTE*>(&bytes),sizeof(bytes),0));
    require(CryptHashData(hash,reinterpret_cast<const BYTE*>(value.data()),bytes,0));
  }
  void walk(const Root& root,const std::wstring& path,bool directory,HANDLE transaction,unsigned depth=0) {
    require(depth<=60&&++entries<=10000);
    auto item=std::make_unique<Handle>(transaction==INVALID_HANDLE_VALUE?
      CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr):
      CreateFileTransactedW(path.c_str(),GENERIC_READ,depth==0?FILE_SHARE_READ|FILE_SHARE_DELETE:FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr,transaction,nullptr,nullptr));
    require(item->value!=INVALID_HANDLE_VALUE);ordinary(item->value,directory);root.check(item->value,true);
    require(within(lower(canonical(root.handle())),lower(canonical(item->value))));
    add(directory?L"directory":L"file");add(identity(item->value));
    HANDLE h=item->value;pins.push_back(std::move(item));
    if(!directory) {
      LARGE_INTEGER size{};require(GetFileSizeEx(h,&size)&&size.QuadPart>=0);
      total+=static_cast<ULONGLONG>(size.QuadPart);require(total<=64ULL*1024*1024);add(std::to_wstring(size.QuadPart));
      BYTE buffer[65536];DWORD count=0;
      do {require(ReadFile(h,buffer,sizeof(buffer),&count,nullptr));if(count) require(CryptHashData(hash,buffer,count,0));} while(count);
      return;
    }
    WIN32_FIND_DATAW data{};auto pattern=path+L"\\*";
    HANDLE found=transaction==INVALID_HANDLE_VALUE?FindFirstFileExW(pattern.c_str(),FindExInfoBasic,&data,FindExSearchNameMatch,nullptr,0):
      FindFirstFileTransactedW(pattern.c_str(),FindExInfoBasic,&data,FindExSearchNameMatch,nullptr,0,transaction);
    require(found!=INVALID_HANDLE_VALUE);
    std::vector<std::pair<std::wstring,bool>> children;
    try {
      do {std::wstring name=data.cFileName;if(name==L"."||name==L"..") continue;
        require(children.size()<10000&&!(data.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
        require(segments(name).size()==1);children.emplace_back(name,bool(data.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY));
      } while(FindNextFileW(found,&data));
      require(GetLastError()==ERROR_NO_MORE_FILES);
    } catch(...) {FindClose(found);throw;}
    FindClose(found);std::sort(children.begin(),children.end());
    add(std::to_wstring(children.size()));
    for(const auto& child:children) {add(child.first);walk(root,path+L"\\"+child.first,child.second,transaction,depth+1);}
  }
  std::wstring version() {
    BYTE digest[32];DWORD size=sizeof(digest);require(CryptGetHashParam(hash,HP_HASHVAL,digest,&size,0)&&size==sizeof(digest));
    static constexpr wchar_t hex[]=L"0123456789abcdef";std::wstring text;
    for(auto byte:digest) {text.push_back(hex[byte>>4]);text.push_back(hex[byte&15]);}return text;
  }
};
void renameHandle(HANDLE source,const std::wstring& destination) {
  auto size=offsetof(FILE_RENAME_INFO,FileName)+(destination.size()+1)*sizeof(wchar_t);
  std::vector<BYTE> bytes(size);auto info=reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());
  info->ReplaceIfExists=FALSE;info->RootDirectory=nullptr;info->FileNameLength=static_cast<DWORD>(destination.size()*sizeof(wchar_t));
  memcpy(info->FileName,destination.data(),info->FileNameLength);
  require(SetFileInformationByHandle(source,FileRenameInfo,info,static_cast<DWORD>(size)));
}
void privateVault(HANDLE h) {
  BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(h,&info));require(info.dwFileAttributes&FILE_ATTRIBUTE_HIDDEN);
  Handle security(CreateFileW(canonical(h).c_str(),READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  require(security.value!=INVALID_HANDLE_VALUE&&identity(security.value)==identity(h));
  PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  require(GetSecurityInfo(security.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&acl,nullptr,&descriptor)==ERROR_SUCCESS);
  struct Free {PSECURITY_DESCRIPTOR p;~Free(){LocalFree(p);}} cleanup{descriptor};
  SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;require(GetSecurityDescriptorControl(descriptor,&control,&revision)&&bool(control&SE_DACL_PROTECTED)&&acl);
  Handle token;require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value));DWORD size=0;
  GetTokenInformation(token.value,TokenUser,nullptr,0,&size);std::vector<BYTE> user(size);require(GetTokenInformation(token.value,TokenUser,user.data(),size,&size));
  auto sid=reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  for(DWORD i=0;i<acl->AceCount;i++) {
    void* raw=nullptr;require(GetAce(acl,i,&raw));auto header=static_cast<ACE_HEADER*>(raw);
    require(header->AceType==ACCESS_ALLOWED_ACE_TYPE||header->AceType==ACCESS_DENIED_ACE_TYPE);
    if(header->AceType==ACCESS_ALLOWED_ACE_TYPE) {auto ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);auto allowed=reinterpret_cast<PSID>(&ace->SidStart);
      require(EqualSid(sid,allowed)||IsWellKnownSid(allowed,WinLocalSystemSid)||IsWellKnownSid(allowed,WinBuiltinAdministratorsSid));}
  }
}

JsonObject perform(const JsonObject& request) {
  auto op=string(request,L"operation");auto path=string(request,L"path");
  if(op==L"list"||op==L"stat"||op==L"read"||op==L"treeStat") strict(request,{});
  else if(op==L"readGitChunk") strict(request,{L"offset",L"length"});
  else if(op==L"mkdir") strict(request,{L"expectedRootIdentity"});
  else if(op==L"write") strict(request,{L"expectedBase64",L"base64",L"expectedRootIdentity",L"expectedFileIdentity"});
  else if(op==L"move"||op==L"trash"||op==L"restore") strict(request,{L"destination",L"expectedBase64",L"expectedRootIdentity",L"expectedFileIdentity",L"expectedKind",L"expectedVersion",L"recoveryRoot",L"recoveryId",L"expectedRecoveryRootIdentity"});
  else deny();
  Root root(request);auto parts=segments(path,op==L"list"||op==L"stat");auto parents=root.parents(parts);
  HANDLE parent=parents.empty()?root.handle():parents.back()->value;
  auto out=success();out.Insert(L"rootIdentity",JsonValue::CreateStringValue(identity(root.handle())));
  if(op==L"list") {
    auto directory=parts.empty()?nullptr:relativeOpen(parent,parts.back(),true);
    HANDLE h=directory?directory->value:root.handle();root.check(h);
    auto pattern=canonical(h)+L"\\*";WIN32_FIND_DATAW data{};HANDLE found=FindFirstFileExW(pattern.c_str(),FindExInfoBasic,&data,FindExSearchNameMatch,nullptr,FIND_FIRST_EX_LARGE_FETCH);
    require(found!=INVALID_HANDLE_VALUE);JsonArray entries;
    try {
      do {
        std::wstring name=data.cFileName;if(name==L"."||name==L"..") continue;
        require(entries.Size()<10000);JsonObject entry;entry.Insert(L"name",JsonValue::CreateStringValue(name));
        entry.Insert(L"type",JsonValue::CreateStringValue(data.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT?L"symlink":data.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY?L"directory":L"file"));
        entries.Append(entry);
      } while(FindNextFileW(found,&data));
      require(GetLastError()==ERROR_NO_MORE_FILES);
    } catch(...) {FindClose(found);throw;}
    FindClose(found);out.Insert(L"entries",entries);out.Insert(L"omitted",JsonValue::CreateBooleanValue(false));return out;
  }
  if(op==L"treeStat") {
    require(!parts.empty());auto full=root.path(parent,parts.back(),true);
    Tree tree;tree.walk(root,full,true,INVALID_HANDLE_VALUE);
    out.Insert(L"kind",JsonValue::CreateStringValue(L"directory"));
    out.Insert(L"identity",JsonValue::CreateStringValue(identity(tree.pins.front()->value)));
    out.Insert(L"version",JsonValue::CreateStringValue(tree.version()));return out;
  }
  if(op==L"readGitChunk") {
    require(gitPackPath(parts));
    const double offsetNumber=request.GetNamedNumber(L"offset");
    const double lengthNumber=request.GetNamedNumber(L"length");
    require(offsetNumber>=0&&offsetNumber<=static_cast<double>(GIT_PACK_MAX)&&
      offsetNumber==static_cast<double>(static_cast<ULONGLONG>(offsetNumber)));
    require(lengthNumber>=1&&lengthNumber<=GIT_CHUNK&&
      lengthNumber==static_cast<double>(static_cast<DWORD>(lengthNumber)));
    auto file=relativeOpen(parent,parts.back(),false);root.check(file->value);
    BY_HANDLE_FILE_INFORMATION before{};require(GetFileInformationByHandle(file->value,&before));
    ULONGLONG total=(static_cast<ULONGLONG>(before.nFileSizeHigh)<<32)|before.nFileSizeLow;
    const auto offset=static_cast<ULONGLONG>(offsetNumber),length=static_cast<DWORD>(lengthNumber);
    require(total>LIMIT&&total<=GIT_PACK_MAX&&offset<=total&&length<=total-offset);
    LARGE_INTEGER location{};location.QuadPart=static_cast<LONGLONG>(offset);
    require(SetFilePointerEx(file->value,location,nullptr,FILE_BEGIN));
    std::vector<BYTE> bytes(length);DWORD received=0;
    require(ReadFile(file->value,bytes.data(),length,&received,nullptr)&&received==length);
    BY_HANDLE_FILE_INFORMATION after{};require(GetFileInformationByHandle(file->value,&after));
    const auto stamp=gitStamp(before);
    require(gitStamp(after)==stamp);
    out.Insert(L"kind",JsonValue::CreateStringValue(L"file"));
    out.Insert(L"identity",JsonValue::CreateStringValue(identity(file->value)));
    out.Insert(L"bytes",JsonValue::CreateNumberValue(length));
    out.Insert(L"totalBytes",JsonValue::CreateNumberValue(static_cast<double>(total)));
    out.Insert(L"gitStamp",JsonValue::CreateStringValue(stamp));
    out.Insert(L"base64",JsonValue::CreateStringValue(encode(bytes)));
    return out;
  }
  if(op==L"read"||op==L"stat") {
    if(parts.empty()) {out.Insert(L"kind",JsonValue::CreateStringValue(L"directory"));out.Insert(L"identity",JsonValue::CreateStringValue(identity(root.handle())));return out;}
    // Stat determines kind through a no-follow metadata handle first. Content
    // reads additionally acquire a non-shared-write, non-shared-delete handle.
    Handle metadata(CreateFileW(root.path(parent,parts.back()).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    require(metadata.value!=INVALID_HANDLE_VALUE);root.check(metadata.value);
    BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(metadata.value,&info));
    bool directory=bool(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY);ordinary(metadata.value,directory);
    out.Insert(L"identity",JsonValue::CreateStringValue(identity(metadata.value)));
    out.Insert(L"kind",JsonValue::CreateStringValue(directory?L"directory":L"file"));
    out.Insert(L"bytes",JsonValue::CreateNumberValue(static_cast<double>((static_cast<ULONGLONG>(info.nFileSizeHigh)<<32)|info.nFileSizeLow)));
    if(op==L"read") {require(!directory);auto file=relativeOpen(parent,parts.back(),false);root.check(file->value);out.Insert(L"base64",JsonValue::CreateStringValue(encode(readBytes(file->value))));}
    return out;
  }
  require(!parts.empty());require(string(request,L"expectedRootIdentity")==identity(root.handle()));
  auto full=root.path(parent,parts.back(),true);
  if((op==L"move"&&request.HasKey(L"expectedKind"))||op==L"trash"||op==L"restore") {
    bool directory=string(request,L"expectedKind")==L"directory";
    require(directory||string(request,L"expectedKind")==L"file");
    std::unique_ptr<Root> vault;
    std::wstring source=full,destination;
    std::vector<std::unique_ptr<Handle>> destinationPins;
    if(op==L"move") {
      auto destParts=segments(string(request,L"destination"));destinationPins=root.parents(destParts);
      destination=root.path(destinationPins.empty()?root.handle():destinationPins.back()->value,destParts.back(),true);
    } else {
      auto recovery=string(request,L"recoveryRoot");auto id=segments(string(request,L"recoveryId"));require(id.size()==1);
      JsonObject vaultRequest=JsonObject::Parse(request.Stringify());vaultRequest.SetNamedValue(L"root",JsonValue::CreateStringValue(recovery));
      vault=std::make_unique<Root>(vaultRequest,true);privateVault(vault->handle());
      require(identity(vault->handle())==string(request,L"expectedRecoveryRootIdentity"));
      auto vaultPath=lower(canonical(vault->handle()));bool protectedVault=false;
      for(auto value:request.GetNamedArray(L"protectedPaths")) {
        auto configured=std::filesystem::absolute(std::wstring(value.GetString())).wstring();
        Handle protection(CreateFileW(configured.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        if(protection.value!=INVALID_HANDLE_VALUE&&within(lower(canonical(protection.value)),vaultPath)) protectedVault=true;
      }
      require(protectedVault&&identity(root.handle())!=identity(vault->handle()));
      auto recovered=vault->path(vault->handle(),id.front(),true);
      if(op==L"restore") {source=recovered;destination=full;} else destination=recovered;
    }
    require(!within(lower(source),lower(destination))&&!within(lower(destination),lower(source)));
    Transaction transaction;
    // The transacted source owns DELETE. Ancestors stay pinned throughout;
    // observed descendants stay pinned until the fixed handle rename step.
    Handle sourceHandle(CreateFileTransactedW(source.c_str(),GENERIC_READ|DELETE|(directory?0:GENERIC_WRITE),FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr,transaction.value,nullptr,nullptr));
    require(sourceHandle.value!=INVALID_HANDLE_VALUE);ordinary(sourceHandle.value,directory);
    const Root& sourceRoot=op==L"restore"?*vault:root;sourceRoot.check(sourceHandle.value,true);
    require(identity(sourceHandle.value)==string(request,L"expectedFileIdentity"));
    if(directory) {
      Tree tree;tree.walk(sourceRoot,source,true,transaction.value);
      require(tree.version()==string(request,L"expectedVersion"));
      tree.pins.clear();renameHandle(sourceHandle.value,destination);
      require(CloseHandle(sourceHandle.value));sourceHandle.value=INVALID_HANDLE_VALUE;transaction.commit();
    } else {
      require(readBytes(sourceHandle.value)==decode(string(request,L"expectedBase64")));
      renameHandle(sourceHandle.value,destination);
      require(CloseHandle(sourceHandle.value));sourceHandle.value=INVALID_HANDLE_VALUE;transaction.commit();
    }
    return out;
  }
  // Keep destination ancestors pinned until after transaction teardown.
  std::vector<std::unique_ptr<Handle>> destinationPins;
  // Native TxF is capability-checked on every mutation and has no unsafe
  // fallback. It is unavailable on some filesystems and discouraged for new
  // general applications by Microsoft; this compatibility debt is explicit.
  Transaction transaction;
  if(op==L"mkdir") require(CreateDirectoryTransactedW(nullptr,full.c_str(),nullptr,transaction.value));
  else {
    bool create=op==L"write"&&request.GetNamedValue(L"expectedBase64").ValueType()==JsonValueType::Null;
    Handle file(CreateFileTransactedW(full.c_str(),GENERIC_READ|GENERIC_WRITE|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,create?CREATE_NEW:OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr,transaction.value,nullptr,nullptr));
    require(file.value!=INVALID_HANDLE_VALUE);ordinary(file.value,false);root.check(file.value,true);
    if(create) require(request.GetNamedValue(L"expectedFileIdentity").ValueType()==JsonValueType::Null);
    else require(string(request,L"expectedFileIdentity")==identity(file.value));
    if(!create) require(readBytes(file.value)==decode(string(request,L"expectedBase64")));
    if(op==L"write") {
      auto bytes=decode(string(request,L"base64"));LARGE_INTEGER zero{};require(SetFilePointerEx(file.value,zero,nullptr,FILE_BEGIN));DWORD written=0;
      require(bytes.empty()||(WriteFile(file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)&&written==bytes.size()));require(SetEndOfFile(file.value));
    } else {
      auto destination=segments(string(request,L"destination"));destinationPins=root.parents(destination);HANDLE destParent=destinationPins.empty()?root.handle():destinationPins.back()->value;
      auto dest=root.path(destParent,destination.back(),true);
      require(MoveFileTransactedW(full.c_str(),dest.c_str(),nullptr,nullptr,0,transaction.value));
    }
  }
  transaction.commit();return out;
}
}

int main() {
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOOPENFILEERRORBOX);SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
  // A killed WSL relay must not leave a native Windows writer running. Closing
  // the process rolls back an uncommitted transaction. The controller must
  // reconcile committed effects before retries; this worker has no journal.
  std::thread([] {Sleep(5000);TerminateProcess(GetCurrentProcess(),124);}).detach();
  try {
    winrt::init_apartment();std::string input;input.reserve(4096);char buffer[4096];
    while(std::cin) {std::cin.read(buffer,sizeof(buffer));auto count=std::cin.gcount();require(input.size()+static_cast<size_t>(count)<=3*LIMIT);input.append(buffer,static_cast<size_t>(count));}
    auto request=JsonObject::Parse(winrt::to_hstring(input));auto response=perform(request);
    std::cout<<winrt::to_string(response.Stringify())<<"\n";return 0;
  } catch(...) {
    std::cout<<(outcome==Outcome::NoChange?"{\"ok\":false,\"code\":\"DENIED_NO_CHANGE\"}\n":"{\"ok\":false,\"code\":\"OUTCOME_UNKNOWN\"}\n");return 1;
  }
}
