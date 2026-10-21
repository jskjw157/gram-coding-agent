// Fixed typed filesystem worker. This is not a command runner or a remote API.
// Trusted composition supplies roots/protected paths; MCP callers never do.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <ktmw32.h>
#include <wincrypt.h>
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
#pragma comment(lib,"KtmW32.lib")
#pragma comment(lib,"Crypt32.lib")
#pragma comment(lib,"windowsapp.lib")

namespace {
using namespace winrt::Windows::Data::Json;
constexpr size_t LIMIT=1024*1024;
struct Failure {};
[[noreturn]] void deny() { throw Failure{}; }
void require(bool value) {if(!value) deny();}
struct Handle {
  HANDLE value=INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE v=INVALID_HANDLE_VALUE):value(v) {}
  ~Handle() {if(value!=INVALID_HANDLE_VALUE) CloseHandle(value);}
  Handle(const Handle&)=delete;
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
    require(key==L"operation"||key==L"root"||key==L"path"||key==L"protectedPaths"||extra.count(key));
  }
}

class Root {
  std::vector<std::unique_ptr<Handle>> pins;
  std::vector<std::wstring> protectedPaths;
  std::set<std::wstring> protectedIdentities;
public:
  explicit Root(const JsonObject& request) {
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
      if(protect.value!=INVALID_HANDLE_VALUE) {protectedIdentities.insert(identity(protect.value));protectedPaths.push_back(lower(canonical(protect.value)));}
      else {require(GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND);protectedPaths.push_back(lower(L"\\\\?\\"+absolute));}
    }
    check(pins.back()->value);
  }
  HANDLE handle() const {return pins.back()->value;}
  void check(HANDLE h) const {
    auto path=lower(canonical(h));require(!protectedIdentities.count(identity(h)));
    for(const auto& protect:protectedPaths) require(!within(protect,path));
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
    return value;
  }
};

JsonObject perform(const JsonObject& request) {
  auto op=string(request,L"operation");auto path=string(request,L"path");
  if(op==L"list"||op==L"stat"||op==L"read"||op==L"mkdir") strict(request,{});
  else if(op==L"write") strict(request,{L"expectedBase64",L"base64"});
  else if(op==L"move") strict(request,{L"destination",L"expectedBase64"});
  else deny();
  Root root(request);auto parts=segments(path,op==L"list"||op==L"stat");auto parents=root.parents(parts);
  HANDLE parent=parents.empty()?root.handle():parents.back()->value;
  auto out=success();
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
    FindClose(found);out.Insert(L"entries",entries);return out;
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
  require(!parts.empty());auto full=root.path(parent,parts.back(),true);
  // Native TxF is capability-checked on every mutation and has no unsafe
  // fallback. It is unavailable on some filesystems and discouraged for new
  // general applications by Microsoft; this compatibility debt is explicit.
  Handle transaction(CreateTransaction(nullptr,nullptr,0,0,0,5000,nullptr));require(transaction.value!=INVALID_HANDLE_VALUE);
  if(op==L"mkdir") require(CreateDirectoryTransactedW(nullptr,full.c_str(),nullptr,transaction.value));
  else {
    bool create=op==L"write"&&request.GetNamedValue(L"expectedBase64").ValueType()==JsonValueType::Null;
    Handle file(CreateFileTransactedW(full.c_str(),GENERIC_READ|GENERIC_WRITE|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,create?CREATE_NEW:OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr,transaction.value,nullptr,nullptr));
    require(file.value!=INVALID_HANDLE_VALUE);ordinary(file.value,false);root.check(file.value);
    if(!create) require(readBytes(file.value)==decode(string(request,L"expectedBase64")));
    if(op==L"write") {
      auto bytes=decode(string(request,L"base64"));LARGE_INTEGER zero{};require(SetFilePointerEx(file.value,zero,nullptr,FILE_BEGIN));DWORD written=0;
      require(bytes.empty()||(WriteFile(file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)&&written==bytes.size()));require(SetEndOfFile(file.value));
    } else {
      auto destination=segments(string(request,L"destination"));auto destPins=root.parents(destination);HANDLE destParent=destPins.empty()?root.handle():destPins.back()->value;
      auto dest=root.path(destParent,destination.back(),true);
      require(MoveFileTransactedW(full.c_str(),dest.c_str(),nullptr,nullptr,0,transaction.value));
    }
  }
  require(CommitTransaction(transaction.value));return out;
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
  } catch(...) {std::cout<<"{\"ok\":false,\"code\":\"DENIED_CONFLICT_OR_UNSUPPORTED\"}\n";return 1;}
}
