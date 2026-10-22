#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <userconsentverifierinterop.h>
#include <sddl.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace
{
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Security::Credentials::UI;

constexpr std::size_t MaxRequestBytes = 2 * 1024 * 1024;
constexpr wchar_t WindowClass[] = L"GramProtectedLocalViewer228";
constexpr wchar_t WindowTitle[] = L"Gram Coding Agent - protected local viewer";
constexpr wchar_t VerificationMessage[] =
    L"Gram Coding Agent: reveal this exact file snapshot in the local protected viewer";

std::int64_t Now() noexcept
{
    FILETIME time{};
    GetSystemTimeAsFileTime(&time);
    ULARGE_INTEGER value{};
    value.LowPart = time.dwLowDateTime;
    value.HighPart = time.dwHighDateTime;
    return static_cast<std::int64_t>(value.QuadPart / 10000ULL) -
        11644473600000LL;
}

void Emit(char const* text) noexcept
{
    static_cast<void>(std::fwrite(text, 1, std::char_traits<char>::length(text), stdout));
    static_cast<void>(std::fflush(stdout));
}

void Deny() noexcept
{
    Emit("{\"status\":\"DENIED\"}\n");
}

// This protocol has objects, strings, numbers and null only. Validate its
// complete JSON grammar and reject duplicate decoded keys before projection.
class StrictJson
{
public:
    explicit StrictJson(std::wstring const& text) : text_(text) {}

    bool Valid()
    {
        Space();
        if (!Object(1)) return false;
        Space();
        return position_ == text_.size();
    }

private:
    std::wstring const& text_;
    std::size_t position_ = 0;

    void Space() noexcept
    {
        while (position_ < text_.size())
        {
            wchar_t const c = text_[position_];
            if (c != L' ' && c != L'\t' && c != L'\r' && c != L'\n') break;
            ++position_;
        }
    }

    bool Take(wchar_t c) noexcept
    {
        Space();
        if (position_ == text_.size() || text_[position_] != c) return false;
        ++position_;
        return true;
    }

    bool String(std::wstring& decoded)
    {
        Space();
        std::size_t const begin = position_;
        if (position_ == text_.size() || text_[position_++] != L'"') return false;
        while (position_ < text_.size())
        {
            wchar_t const c = text_[position_++];
            if (c < 0x20) return false;
            if (c == L'\\')
            {
                if (position_ == text_.size()) return false;
                ++position_;
            }
            else if (c == L'"')
            {
                auto const value = JsonValue::Parse(
                    winrt::hstring(text_.substr(begin, position_ - begin)));
                auto const string = value.GetString();
                decoded.assign(string.c_str(), string.size());
                for (std::size_t i = 0; i < decoded.size(); ++i)
                {
                    unsigned const unit = static_cast<unsigned>(decoded[i]);
                    if (unit >= 0xD800 && unit <= 0xDBFF)
                    {
                        if (++i == decoded.size()) return false;
                        unsigned const next = static_cast<unsigned>(decoded[i]);
                        if (next < 0xDC00 || next > 0xDFFF) return false;
                    }
                    else if (unit >= 0xDC00 && unit <= 0xDFFF)
                    {
                        return false;
                    }
                }
                return true;
            }
        }
        return false;
    }

    bool Digits() noexcept
    {
        std::size_t const begin = position_;
        while (position_ < text_.size() &&
               text_[position_] >= L'0' && text_[position_] <= L'9')
        {
            ++position_;
        }
        return position_ != begin;
    }

    bool Number() noexcept
    {
        if (position_ < text_.size() && text_[position_] == L'-') ++position_;
        if (position_ == text_.size()) return false;
        if (text_[position_] == L'0')
        {
            ++position_;
        }
        else if (text_[position_] >= L'1' && text_[position_] <= L'9')
        {
            if (!Digits()) return false;
        }
        else
        {
            return false;
        }
        if (position_ < text_.size() && text_[position_] == L'.')
        {
            ++position_;
            if (!Digits()) return false;
        }
        if (position_ < text_.size() &&
            (text_[position_] == L'e' || text_[position_] == L'E'))
        {
            ++position_;
            if (position_ < text_.size() &&
                (text_[position_] == L'+' || text_[position_] == L'-'))
            {
                ++position_;
            }
            if (!Digits()) return false;
        }
        return true;
    }

    bool Value(unsigned depth)
    {
        Space();
        if (position_ == text_.size()) return false;
        if (text_[position_] == L'{') return Object(depth + 1);
        if (text_[position_] == L'"')
        {
            std::wstring ignored;
            return String(ignored);
        }
        if (text_.compare(position_, 4, L"null") == 0)
        {
            position_ += 4;
            return true;
        }
        return Number();
    }

    bool Object(unsigned depth)
    {
        if (depth > 2 || !Take(L'{')) return false;
        std::set<std::wstring> names;
        if (Take(L'}')) return true;
        do
        {
            std::wstring name;
            if (!String(name) || !names.insert(name).second ||
                !Take(L':') || !Value(depth))
            {
                return false;
            }
            if (Take(L'}')) return true;
        } while (Take(L','));
        return false;
    }
};

bool ReadRequest(std::wstring& text)
{
    std::string bytes;
    char buffer[1024];
    for (;;)
    {
        std::size_t const count = std::fread(buffer, 1, sizeof(buffer), stdin);
        if (count > MaxRequestBytes - bytes.size()) return false;
        bytes.append(buffer, count);
        if (count < sizeof(buffer))
        {
            if (std::ferror(stdin)) return false;
            if (std::feof(stdin)) break;
        }
    }
    if (bytes.empty()) return false;
    int const length = static_cast<int>(bytes.size());
    int const required = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), length, nullptr, 0);
    if (required <= 0) return false;
    text.resize(static_cast<std::size_t>(required));
    return MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), length,
        text.data(), required) == required;
}

bool Keys(JsonObject const& object,
          std::initializer_list<wchar_t const*> names)
{
    if (object.Size() != static_cast<std::uint32_t>(names.size())) return false;
    for (auto const name : names)
    {
        if (!object.HasKey(name)) return false;
    }
    return true;
}

std::wstring String(JsonObject const& object, wchar_t const* name)
{
    auto const value = object.GetNamedString(name);
    return {value.c_str(), value.size()};
}

bool SafeInteger(JsonObject const& object, wchar_t const* name,
                 std::int64_t& result)
{
    double const number = object.GetNamedNumber(name);
    if (!std::isfinite(number) || number < 0 ||
        number > 9007199254740991.0 || std::floor(number) != number)
    {
        return false;
    }
    result = static_cast<std::int64_t>(number);
    return true;
}

bool LowerHex(wchar_t c) noexcept
{
    return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f');
}

bool ChallengeId(std::wstring const& value) noexcept
{
    if (value.size() != 36 || value[14] != L'4' ||
        (value[19] != L'8' && value[19] != L'9' &&
         value[19] != L'a' && value[19] != L'b'))
    {
        return false;
    }
    for (std::size_t i = 0; i < value.size(); ++i)
    {
        bool const separator = i == 8 || i == 13 || i == 18 || i == 23;
        if (separator ? value[i] != L'-' : !LowerHex(value[i])) return false;
    }
    return true;
}

bool RootId(std::wstring const& value) noexcept
{
    if (value.empty() || value.size() > 32 || value[0] < L'a' || value[0] > L'z') return false;
    for (std::size_t i = 0; i < value.size(); ++i)
    {
        wchar_t const c = value[i];
        bool const alphanumeric =
            (c >= L'a' && c <= L'z') || (c >= L'0' && c <= L'9');
        if (!alphanumeric && (i == 0 || (c != L'-' && c != L'_'))) return false;
    }
    return true;
}

bool RelativePath(std::wstring const& value) noexcept
{
    if (value.empty() || value.size() > 2048) return false;
    std::size_t begin = 0;
    for (std::size_t i = 0; i <= value.size(); ++i)
    {
        if (i == value.size() || value[i] == L'/')
        {
            std::size_t const length = i - begin;
            if (length == 0 || value[i - 1] == L'.' || value[i - 1] == L' ' ||
                (length == 1 && value[begin] == L'.') ||
                (length == 2 && value[begin] == L'.' && value[begin + 1] == L'.'))
            {
                return false;
            }
            begin = i + 1;
        }
        else
        {
            wchar_t const c = value[i];
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F) ||
                c == L'\\' || c == L':' || c == L'<' || c == L'>' ||
                c == L'"' || c == L'|' || c == L'?' || c == L'*')
            {
                return false;
            }
        }
    }
    return true;
}

std::wstring CurrentOwner()
{
    HANDLE rawToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) return {};
    winrt::handle token{rawToken};
    DWORD required = 0;
    if (GetTokenInformation(token.get(), TokenUser, nullptr, 0, &required) ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER || required < sizeof(TOKEN_USER))
    {
        return {};
    }
    std::vector<BYTE> storage(required);
    if (!GetTokenInformation(
            token.get(), TokenUser, storage.data(), required, &required))
    {
        return {};
    }
    auto const user = reinterpret_cast<TOKEN_USER const*>(storage.data());
    struct SidString
    {
        LPWSTR value = nullptr;
        ~SidString() { if (value) LocalFree(value); }
    } sid;
    if (!ConvertSidToStringSidW(user->User.Sid, &sid.value)) return {};
    return std::wstring(sid.value);
}

struct WindowState
{
    std::wstring text;
    std::int64_t issuedAt = 0;
    std::int64_t expiresAt = 0;
    ULONGLONG deadline = 0;
    bool closed = false;
    int scroll = 0;
    int maximumScroll = 0;
};

bool Live(WindowState const& state) noexcept
{
    std::int64_t const now = Now();
    return !state.closed && now >= state.issuedAt && now < state.expiresAt &&
        GetTickCount64() < state.deadline;
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message,
                                 WPARAM wparam, LPARAM lparam)
{
    auto state = reinterpret_cast<WindowState*>(
        GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE)
    {
        auto const creation = reinterpret_cast<CREATESTRUCTW const*>(lparam);
        state = static_cast<WindowState*>(creation->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    if (!state) return DefWindowProcW(window, message, wparam, lparam);
    switch (message)
    {
    case WM_CLOSE:
        DestroyWindow(window);
        return 0;
    case WM_DESTROY:
        state->closed = true;
        return 0;
    case WM_COMMAND:
        if (LOWORD(wparam) == IDCANCEL)
        {
            DestroyWindow(window);
            return 0;
        }
        break;
    case WM_TIMER:
        if (!Live(*state)) DestroyWindow(window);
        return 0;
    case WM_SIZE:
    {
        RECT client{};
        GetClientRect(window, &client);
        MoveWindow(GetDlgItem(window, IDCANCEL),
                   16, std::max(0L, client.bottom - 48), 120, 32, TRUE);
        InvalidateRect(window, nullptr, TRUE);
        return 0;
    }
    case WM_VSCROLL:
    {
        int next = state->scroll;
        switch (LOWORD(wparam))
        {
        case SB_LINEUP: next -= 24; break;
        case SB_LINEDOWN: next += 24; break;
        case SB_PAGEUP: next -= 240; break;
        case SB_PAGEDOWN: next += 240; break;
        case SB_TOP: next = 0; break;
        case SB_BOTTOM: next = state->maximumScroll; break;
        case SB_THUMBTRACK:
        {
            SCROLLINFO info{};
            info.cbSize = sizeof(info);
            info.fMask = SIF_TRACKPOS;
            if (GetScrollInfo(window, SB_VERT, &info)) next = info.nTrackPos;
            break;
        }
        default: break;
        }
        state->scroll = std::clamp(next, 0, state->maximumScroll);
        InvalidateRect(window, nullptr, TRUE);
        return 0;
    }
    case WM_MOUSEWHEEL:
        state->scroll = std::clamp(
            state->scroll - (GET_WHEEL_DELTA_WPARAM(wparam) / WHEEL_DELTA) * 72,
            0, state->maximumScroll);
        InvalidateRect(window, nullptr, TRUE);
        return 0;
    case WM_PAINT:
    {
        PAINTSTRUCT paint{};
        HDC const dc = BeginPaint(window, &paint);
        RECT client{};
        GetClientRect(window, &client);
        RECT layout{16, 0, std::max(32L, client.right - 16), 0};
        constexpr UINT flags = DT_LEFT | DT_WORDBREAK | DT_NOPREFIX;
        DrawTextW(dc, state->text.c_str(), static_cast<int>(state->text.size()),
                  &layout, flags | DT_CALCRECT);
        int const viewport = static_cast<int>(std::max(1L, client.bottom - 80));
        int const height = static_cast<int>(layout.bottom - layout.top);
        state->maximumScroll = std::max(0, height - viewport);
        state->scroll = std::clamp(state->scroll, 0, state->maximumScroll);
        SCROLLINFO info{};
        info.cbSize = sizeof(info);
        info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
        info.nMax = std::max(0, height - 1);
        info.nPage = static_cast<UINT>(viewport);
        info.nPos = state->scroll;
        SetScrollInfo(window, SB_VERT, &info, TRUE);
        IntersectClipRect(dc, 16, 16, client.right - 16, client.bottom - 64);
        SetBkMode(dc, TRANSPARENT);
        layout.top = 16 - state->scroll;
        layout.bottom = layout.top + height;
        DrawTextW(dc, state->text.c_str(), static_cast<int>(state->text.size()),
                  &layout, flags);
        EndPaint(window, &paint);
        return 0;
    }
    default:
        break;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

bool Pump() noexcept
{
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
    {
        if (message.message == WM_QUIT) return false;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return true;
}

template<typename T>
bool Wait(IAsyncOperation<T> const& operation, ULONGLONG deadline,
          WindowState const* state = nullptr)
{
    for (;;)
    {
        if (!Pump() || GetTickCount64() >= deadline || (state && !Live(*state)))
        {
            try { operation.Cancel(); } catch (...) {}
            return false;
        }
        winrt::Windows::Foundation::AsyncStatus const status = operation.Status();
        if (status == winrt::Windows::Foundation::AsyncStatus::Completed) return true;
        if (status != winrt::Windows::Foundation::AsyncStatus::Started) return false;
        DWORD const waited = MsgWaitForMultipleObjectsEx(
            0, nullptr, 25, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        if (waited == WAIT_FAILED)
        {
            try { operation.Cancel(); } catch (...) {}
            return false;
        }
    }
}

bool Available(ULONGLONG deadline)
{
    auto const operation = UserConsentVerifier::CheckAvailabilityAsync();
    return Wait(operation, deadline) &&
        operation.GetResults() == UserConsentVerifierAvailability::Available;
}

void AppendDisplay(std::wstring& text, wchar_t const* label,
                   std::wstring const& value)
{
    text += label;
    text += L"\r\n";
    unsigned column = 0;
    for (std::size_t i = 0; i < value.size(); ++i)
    {
        wchar_t const c = value[i];
        text += c;
        ++column;
        bool const highSurrogate = c >= 0xD800 && c <= 0xDBFF;
        if (column >= 72 && !highSurrogate)
        {
            text += L"\r\n";
            column = 0;
        }
    }
    text += L"\r\n\r\n";
}

struct OwnedWindow
{
    HWND value = nullptr;
    ~OwnedWindow()
    {
        if (value && IsWindow(value)) DestroyWindow(value);
    }
};


bool DecodeContent(std::wstring const& encoded, std::wstring const& digest,
                   std::vector<BYTE>& bytes, std::wstring& raw)
{
    if (encoded.empty() || encoded.size() > 349528) return false;
    DWORD size = 0;
    if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()),
            CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) ||
        size > 256 * 1024 || size == 0) return false;
    bytes.resize(size);
    if (!CryptStringToBinaryW(encoded.c_str(), static_cast<DWORD>(encoded.size()),
            CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, bytes.data(), &size, nullptr, nullptr)) return false;
    if (std::find(bytes.begin(), bytes.end(), BYTE{0}) != bytes.end()) return false;
    BYTE hash[32]{};
    if (BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, bytes.data(), size,
                   hash, sizeof(hash)) < 0) return false;
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring actual;
    for (BYTE const value : hash) { actual += hex[value >> 4]; actual += hex[value & 15]; }
    if (actual != digest) return false;
    int const required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        reinterpret_cast<char const*>(bytes.data()), static_cast<int>(size), nullptr, 0);
    if (required <= 0) return false;
    raw.resize(static_cast<std::size_t>(required));
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        reinterpret_cast<char const*>(bytes.data()), static_cast<int>(size),
        raw.data(), required) == required;
}

void Run()
{
    std::wstring text;
    if (!ReadRequest(text) || !StrictJson(text).Valid())
    {
        Deny();
        return;
    }
    auto const request = JsonObject::Parse(winrt::hstring(text));
    std::wstring const operation = String(request, L"operation");
    if (operation == L"availability")
    {
        if (!Keys(request, {L"operation"}))
        {
            Deny();
            return;
        }
        bool available = false;
        try { available = Available(GetTickCount64() + 5000); } catch (...) {}
        Emit(available ? "{\"status\":\"AVAILABLE\"}\n" :
                         "{\"status\":\"UNAVAILABLE\"}\n");
        return;
    }
    if (operation != L"view" ||
        !Keys(request, {L"operation", L"challengeId", L"bindingDigest",
                        L"issuedAt", L"expiresAt", L"expectedOwnerSid", L"target", L"contentBase64"}))
    {
        Deny();
        return;
    }

    std::wstring const challenge = String(request, L"challengeId");
    std::wstring const digest = String(request, L"bindingDigest");
    std::wstring const expectedOwner = String(request, L"expectedOwnerSid");
    WindowState state;
    if (!ChallengeId(challenge) || digest.size() != 64 ||
        !std::all_of(digest.begin(), digest.end(), LowerHex) ||
        !SafeInteger(request, L"issuedAt", state.issuedAt) ||
        !SafeInteger(request, L"expiresAt", state.expiresAt))
    {
        Deny();
        return;
    }
    std::int64_t const now = Now();
    if (state.issuedAt > now || state.expiresAt <= now ||
        state.expiresAt <= state.issuedAt ||
        state.expiresAt - state.issuedAt > 120000)
    {
        Deny();
        return;
    }
    state.deadline = GetTickCount64() +
        static_cast<ULONGLONG>(state.expiresAt - now);

    auto const target = request.GetNamedObject(L"target");
    if (!Keys(target, {L"action", L"rootId", L"path", L"destination"}))
    {
        Deny();
        return;
    }
    std::wstring const action = String(target, L"action");
    std::wstring const root = String(target, L"rootId");
    std::wstring const path = String(target, L"path");
    auto const destinationValue = target.GetNamedValue(L"destination");
    bool const hasDestination = destinationValue.ValueType() != JsonValueType::Null;
    std::wstring destination;
    if (hasDestination)
    {
        auto const value = destinationValue.GetString();
        destination.assign(value.c_str(), value.size());
    }
    if (action != L"protected-reveal" || !RootId(root) || !RelativePath(path) || hasDestination)
    {
        Deny();
        return;
    }
    std::wstring const encoded = String(request, L"contentBase64");
    std::vector<BYTE> bytes;
    std::wstring raw;
    if (!DecodeContent(encoded, digest, bytes, raw)) { Deny(); return; }
    std::wstring const owner = CurrentOwner();
    if (owner.empty() || owner != expectedOwner || !Live(state))
    {
        Deny();
        return;
    }
    bool available = false;
    try
    {
        available = Available(std::min(state.deadline, GetTickCount64() + 5000));
    }
    catch (...) {}
    if (!Live(state))
    {
        Deny();
        return;
    }
    if (!available)
    {
        Emit("{\"status\":\"UNAVAILABLE\"}\n");
        return;
    }

    state.text = L"Authorize this one local file operation.\r\n\r\n";
    AppendDisplay(state.text, L"Operation:", action);
    AppendDisplay(state.text, L"Root:", root);
    AppendDisplay(state.text, L"Relative path:", path);
    AppendDisplay(state.text, L"Destination:",
                  hasDestination ? destination : L"(none)");

    HINSTANCE const instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = WindowProcedure;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    windowClass.lpszClassName = WindowClass;
    if (!RegisterClassExW(&windowClass))
    {
        Deny();
        return;
    }
    OwnedWindow window;
    window.value = CreateWindowExW(
        0, WindowClass, WindowTitle,
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_VSCROLL,
        CW_USEDEFAULT, CW_USEDEFAULT, 900, 650,
        nullptr, nullptr, instance, &state);
    if (!window.value)
    {
        Deny();
        return;
    }
    // This feature targets Windows 11. Refuse disclosure if the OS cannot
    // positively establish capture exclusion; monitor-only fallback is weaker.
    DWORD affinity = WDA_NONE;
    if (!SetWindowDisplayAffinity(window.value, 0x00000011) ||
        !GetWindowDisplayAffinity(window.value, &affinity) || affinity != 0x00000011)
    {
        Deny();
        return;
    }
    HWND const cancel = CreateWindowExW(
        0, L"BUTTON", L"Cancel", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
        16, 550, 120, 32, window.value,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDCANCEL)), instance, nullptr);
    if (!cancel || SetTimer(window.value, 1, 50, nullptr) == 0)
    {
        Deny();
        return;
    }
    ShowWindow(window.value, SW_SHOWNORMAL);
    UpdateWindow(window.value);
    if (!Pump() || !Live(state) || !IsWindowVisible(window.value) ||
        !GetWindowDisplayAffinity(window.value, &affinity) || affinity != 0x00000011)
    {
        Deny();
        return;
    }

    auto const interop = winrt::get_activation_factory<
        UserConsentVerifier, IUserConsentVerifierInterop>();
    IAsyncOperation<UserConsentVerificationResult> verification{nullptr};
    winrt::hstring const message{VerificationMessage};
    winrt::check_hresult(interop->RequestVerificationForWindowAsync(
        window.value, reinterpret_cast<HSTRING>(winrt::get_abi(message)),
        winrt::guid_of<IAsyncOperation<UserConsentVerificationResult>>(),
        winrt::put_abi(verification)));
    if (!Wait(verification, state.deadline, &state) ||
        verification.GetResults() != UserConsentVerificationResult::Verified)
    {
        Deny();
        return;
    }

    if (!Pump() || !Live(state) || !IsWindowVisible(window.value) ||
        !GetWindowDisplayAffinity(window.value, &affinity) || affinity != 0x00000011)
    {
        Deny();
        return;
    }
    // File text is painted as inert GDI text only after this fresh Hello proof.
    // No edit control, clipboard, HTML, stdout body or content-bearing caption.
    state.text = raw;
    state.scroll = 0;
    InvalidateRect(window.value, nullptr, TRUE);
    UpdateWindow(window.value);
    if (!Live(state) || !IsWindowVisible(window.value)) { Deny(); return; }
    Emit("{\"status\":\"DISPLAYED\"}\n");
    SecureZeroMemory(bytes.data(), bytes.size());
    SecureZeroMemory(raw.data(), raw.size() * sizeof(wchar_t));
    while (Live(state) && Pump())
    {
        if (MsgWaitForMultipleObjectsEx(0, nullptr, 25, QS_ALLINPUT,
                                      MWMO_INPUTAVAILABLE) == WAIT_FAILED) break;
    }
    SecureZeroMemory(state.text.data(), state.text.size() * sizeof(wchar_t));

}
}

int main(int argc, char*[])
{
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
        _setmode(_fileno(stdout), _O_BINARY) == -1 || argc != 1)
    {
        Deny();
        return 0;
    }
    try
    {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        Run();
    }
    catch (...)
    {
        Deny();
    }
    return 0;
}
