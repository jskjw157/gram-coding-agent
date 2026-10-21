#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

typedef enum { RESULT_OWNED = 0, RESULT_FOREIGN = 1, RESULT_UNKNOWN = 2 } result_t;

static int parse_u64(const char *text, uint64_t *out) {
    if (text == NULL || *text == '\0') return 0;
    uint64_t value = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; ++p) {
        if (*p < '0' || *p > '9') return 0;
        uint64_t digit = (uint64_t)(*p - '0');
        if (value > (UINT64_MAX - digit) / 10U) return 0;
        value = value * 10U + digit;
    }
    *out = value;
    return 1;
}

static void emit_result(result_t result) {
    if (result == RESULT_OWNED) fputs("OWNED\n", stdout);
    else if (result == RESULT_FOREIGN) fputs("FOREIGN\n", stdout);
    else fputs("UNKNOWN\n", stdout);
}

static result_t process_identity(pid_t pid, uid_t uid, int check_start,
    uint64_t start_sec, uint64_t start_usec, uint64_t expected_dev, uint64_t expected_ino,
    struct proc_bsdinfo *out_info) {
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
    if (got != (int)sizeof(info)) return errno == ESRCH ? RESULT_FOREIGN : RESULT_UNKNOWN;
    if ((pid_t)info.pbi_pid != pid || info.pbi_uid != uid) return RESULT_FOREIGN;
    if (check_start && (info.pbi_start_tvsec != start_sec || info.pbi_start_tvusec != start_usec)) return RESULT_FOREIGN;

    char path[PROC_PIDPATHINFO_MAXSIZE];
    memset(path, 0, sizeof(path));
    if (proc_pidpath(pid, path, (uint32_t)sizeof(path)) <= 0) return RESULT_UNKNOWN;
    struct stat executable;
    if (stat(path, &executable) != 0) return RESULT_UNKNOWN;
    if ((uint64_t)executable.st_dev != expected_dev || (uint64_t)executable.st_ino != expected_ino) return RESULT_FOREIGN;
    if (out_info != NULL) *out_info = info;
    return RESULT_OWNED;
}

static int ipv4_loopback(const struct in4in6_addr *value) {
    return value->i46a_addr4.s_addr == htonl(INADDR_LOOPBACK);
}

static result_t accepted_socket(pid_t pid, const struct proc_bsdinfo *info, uint16_t server_port, uint16_t client_port) {
    uint64_t requested = (uint64_t)info->pbi_nfiles + 64U;
    if (requested < 64U) requested = 64U;
    if (requested > 16384U) return RESULT_UNKNOWN;
    size_t capacity = (size_t)requested;
    struct proc_fdinfo *fds = calloc(capacity, sizeof(*fds));
    if (fds == NULL) return RESULT_UNKNOWN;

    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)(capacity * sizeof(*fds)));
    if (bytes <= 0 || ((size_t)bytes % sizeof(*fds)) != 0U) {
        free(fds);
        return RESULT_UNKNOWN;
    }
    size_t count = (size_t)bytes / sizeof(*fds);
    if (count >= capacity) {
        free(fds);
        return RESULT_UNKNOWN;
    }

    int socket_fds = 0;
    int inspected = 0;
    for (size_t i = 0; i < count; ++i) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        socket_fds++;
        struct socket_fdinfo sfi;
        memset(&sfi, 0, sizeof(sfi));
        int got = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &sfi, (int)sizeof(sfi));
        if (got != (int)sizeof(sfi)) continue;
        inspected++;
        if (sfi.psi.soi_family != AF_INET || sfi.psi.soi_protocol != IPPROTO_TCP
            || sfi.psi.soi_kind != SOCKINFO_TCP) continue;
        const struct tcp_sockinfo *tcp = &sfi.psi.soi_proto.pri_tcp;
        const struct in_sockinfo *inet = &tcp->tcpsi_ini;
        if (tcp->tcpsi_state != TSI_S_ESTABLISHED || (inet->insi_vflag & INI_IPV4) == 0) continue;
        if (!ipv4_loopback(&inet->insi_laddr.ina_46) || !ipv4_loopback(&inet->insi_faddr.ina_46)) continue;
        if (ntohs((uint16_t)inet->insi_lport) == server_port
            && ntohs((uint16_t)inet->insi_fport) == client_port) {
            free(fds);
            return RESULT_OWNED;
        }
    }
    free(fds);
    if (socket_fds > 0 && inspected == 0) return RESULT_UNKNOWN;
    return RESULT_FOREIGN;
}

int main(int argc, char **argv) {
    if (argc != 5 && argc != 7 && argc != 9) return 2;
    uint64_t pid64 = 0, uid64 = 0, start_sec = 0, start_usec = 0, dev = 0, ino = 0;
    uint64_t server_port = 0, client_port = 0;
    if (!parse_u64(argv[1], &pid64) || pid64 == 0 || pid64 > INT32_MAX
        || !parse_u64(argv[2], &uid64) || uid64 == 0 || uid64 >= UINT32_MAX) return 2;

    int check_start = argc >= 7;
    int dev_index = 3;
    if (check_start) {
        if (!parse_u64(argv[3], &start_sec) || !parse_u64(argv[4], &start_usec) || start_usec > 999999U) return 2;
        dev_index = 5;
    }
    if (!parse_u64(argv[dev_index], &dev) || !parse_u64(argv[dev_index + 1], &ino) || ino == 0) return 2;
    if (argc == 9) {
        if (!parse_u64(argv[7], &server_port) || server_port == 0 || server_port > 65535U
            || !parse_u64(argv[8], &client_port) || client_port == 0 || client_port > 65535U) return 2;
    }

    struct proc_bsdinfo info;
    result_t result = process_identity((pid_t)pid64, (uid_t)uid64, check_start,
        start_sec, start_usec, dev, ino, &info);
    if (argc == 5) {
        if (result == RESULT_OWNED) {
            printf("START %llu %llu\n",
                (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
            return 0;
        }
        emit_result(result);
        return 0;
    }
    if (argc == 7 || result != RESULT_OWNED) {
        emit_result(result);
        return 0;
    }
    emit_result(accepted_socket((pid_t)pid64, &info, (uint16_t)server_port, (uint16_t)client_port));
    return 0;
}
