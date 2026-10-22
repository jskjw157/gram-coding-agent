#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Linux UAPI ABI 7 layout: include/uapi/linux/landlock.h. Keep the complete
 * 24-byte contract even when building against Ubuntu 24.04's older headers.
 * Runtime ABI >= 7 remains mandatory; this is not a security fallback. */
struct gram_landlock_ruleset_attr {
    uint64_t handled_access_fs;
    uint64_t handled_access_net;
    uint64_t scoped;
};
_Static_assert(sizeof(struct gram_landlock_ruleset_attr) == 24, "Landlock ABI layout");
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

/* A second boundary inside the parent's minimal bubblewrap mount/PID/network
 * namespaces. Not a broker, UID separation, or a Windows-host sandbox. */
static void die(const char *message) { fprintf(stderr, "sandbox entry: %s\n", message); exit(125); }
static void canonical(const char *path) {
    char *resolved = realpath(path, NULL);
    if (!resolved || path[0] != '/' || strcmp(resolved, path) || !strcmp(path, "/")) die("noncanonical path");
    free(resolved);
}
static void rule(int fd, const char *path, uint64_t rights, int optional) {
    int parent = open(path, O_PATH | O_CLOEXEC);
    if (parent < 0) { if (optional && errno == ENOENT) return; die("required path unavailable"); }
    struct landlock_path_beneath_attr attr = {.allowed_access=rights, .parent_fd=parent};
    if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0)) die("Landlock path rule failed");
    close(parent);
}
static void script_rule(int fd, const char *workspace, const char *path) {
    canonical(path);
    size_t root_len=strlen(workspace);
    if (strncmp(path,workspace,root_len) || path[root_len]!='/') die("script outside workspace");
    int file=open(path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    struct stat st; struct statvfs mount; char prefix[20]={0};
    if(file<0 || fstat(file,&st) || fstatvfs(file,&mount) || !S_ISREG(st.st_mode) ||
       st.st_nlink!=1 || st.st_uid!=getuid() || !(mount.f_flag&ST_RDONLY) ||
       read(file,prefix,sizeof(prefix))<20 || memcmp(prefix,"#!/usr/bin/env node\n",20)) die("script is not an immutable Node entrypoint");
    struct landlock_path_beneath_attr attr={.allowed_access=LANDLOCK_ACCESS_FS_EXECUTE|LANDLOCK_ACCESS_FS_READ_FILE,.parent_fd=file};
    if(syscall(SYS_landlock_add_rule,fd,LANDLOCK_RULE_PATH_BENEATH,&attr,0)) die("script execute rule failed");
    close(file);
}
#define STMT(c,k) ((struct sock_filter)BPF_STMT(c,k))
#define JUMP(c,k,t,f) ((struct sock_filter)BPF_JUMP(c,k,t,f))
static struct sock_filter filter[512];
static size_t count;
static void emit(struct sock_filter instruction) { if (count >= 512) die("filter overflow"); filter[count++]=instruction; }
static void allow(int nr) {
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,(unsigned)nr,0,1)); emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW));
}
/* Match one syscall and constrain its low 32-bit first argument, then reload
 * the syscall number for the remaining default-deny allowlist. */
static void argument_equals(int nr, unsigned value) {
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,(unsigned)nr,0,4));
    emit(STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,value,0,1));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM));
}
static void seccomp(void) {
    emit(STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS));
    emit(STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)));
    emit(JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_clone3,0,1));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_clone,0,4));
    emit(STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])));
    emit(JUMP(BPF_JMP|BPF_JSET|BPF_K,CLONE_NEWNS|CLONE_NEWCGROUP|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|CLONE_PTRACE|CLONE_UNTRACED,1,0));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM));
    argument_equals(SYS_socketpair,AF_UNIX);
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_ioctl,0,7));
    emit(STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[1])));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,FIONBIO,4,0));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,FIONREAD,3,0));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,TCGETS,2,0));
    emit(JUMP(BPF_JMP|BPF_JEQ|BPF_K,TIOCGWINSZ,1,0));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM));
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW));
    /* Thread names are needed by libuv. Do not allow changing dumpability. */
    argument_equals(SYS_prctl,PR_SET_NAME);
    const int allowed[] = {
        SYS_read,SYS_write,SYS_readv,SYS_writev,SYS_pread64,SYS_pwrite64,
        SYS_close,SYS_close_range,SYS_open,SYS_openat,SYS_fstat,SYS_stat,SYS_lstat,
        SYS_newfstatat,SYS_statx,SYS_lseek,SYS_access,SYS_faccessat,SYS_faccessat2,
        SYS_readlink,SYS_readlinkat,SYS_getdents,SYS_getdents64,
        SYS_mmap,SYS_mprotect,SYS_munmap,SYS_mremap,SYS_madvise,SYS_brk,
        SYS_rt_sigaction,SYS_rt_sigprocmask,SYS_rt_sigreturn,SYS_sigaltstack,
        SYS_futex,SYS_set_robust_list,SYS_get_robust_list,SYS_rseq,
        SYS_arch_prctl,SYS_set_tid_address,SYS_getpid,SYS_getppid,SYS_gettid,
        SYS_getuid,SYS_geteuid,SYS_getgid,SYS_getegid,SYS_getgroups,
        SYS_getcwd,SYS_chdir,SYS_fchdir,SYS_umask,
        SYS_mkdir,SYS_mkdirat,SYS_rmdir,SYS_unlink,SYS_unlinkat,SYS_rename,SYS_renameat,SYS_renameat2,
        SYS_link,SYS_linkat,SYS_symlink,SYS_symlinkat,SYS_chmod,SYS_fchmod,SYS_fchmodat,
        SYS_truncate,SYS_ftruncate,SYS_fsync,SYS_fdatasync,SYS_flock,
        SYS_fcntl,SYS_dup,SYS_dup2,SYS_dup3,SYS_pipe,SYS_pipe2,
        SYS_poll,SYS_ppoll,SYS_select,SYS_pselect6,SYS_epoll_create,SYS_epoll_create1,
        SYS_epoll_ctl,SYS_epoll_wait,SYS_epoll_pwait,SYS_epoll_pwait2,SYS_eventfd2,
        SYS_clock_gettime,SYS_clock_getres,SYS_clock_nanosleep,SYS_nanosleep,SYS_gettimeofday,SYS_time,
        SYS_timerfd_create,SYS_timerfd_settime,SYS_timerfd_gettime,
        SYS_getrandom,SYS_uname,SYS_sysinfo,SYS_getrlimit,SYS_getrusage,SYS_prlimit64,
        SYS_sched_getaffinity,SYS_sched_yield,SYS_sched_getparam,SYS_sched_getscheduler,
        SYS_fork,SYS_vfork,SYS_execve,SYS_wait4,SYS_waitid,SYS_exit,SYS_exit_group,
        SYS_kill,SYS_tkill,SYS_tgkill,SYS_setsid,SYS_setpgid,SYS_getpgid,SYS_getpgrp,SYS_getsid,
        SYS_sendmsg,SYS_recvmsg,SYS_sendto,SYS_recvfrom,SYS_shutdown,SYS_getsockname,SYS_getpeername,
        SYS_setsockopt,SYS_getsockopt,SYS_utime,SYS_utimes,SYS_utimensat,SYS_statfs,SYS_fstatfs,
        SYS_copy_file_range,SYS_sendfile,SYS_splice,SYS_tee,SYS_vmsplice
    };
    for (size_t i=0;i<sizeof(allowed)/sizeof(allowed[0]);i++) allow(allowed[i]);
    emit(STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM));
    struct sock_fprog program={.len=(unsigned short)count,.filter=filter};
    if (prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)) die("seccomp install failed");
}
int main(int argc, char **argv) {
#if !defined(__x86_64__) || defined(__ILP32__)
#error Only native Linux x86_64 is supported
#endif
    if (argc < 5) die("invalid arguments");
    int command=3,script_count=0;
    while(command+1<argc && !strcmp(argv[command],"--script")) {
        if(++script_count>256) die("too many script entrypoints");
        command+=2;
    }
    if(command+1>=argc || strcmp(argv[command],"--")) die("invalid command separator");
    command++;
    canonical(argv[1]); canonical(argv[2]); canonical(argv[command]);
    size_t n = strlen(argv[2]);
    int node_executable = !strncmp(argv[command],argv[2],n) && argv[command][n]=='/';
    int system_executable = !strncmp(argv[command],"/usr/bin/",9) && !strchr(argv[command]+9,'/');
    if (!node_executable && !system_executable) die("executable outside runtime");
    int abi = (int)syscall(SYS_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 7) die("Landlock ABI 7 required");
    uint64_t read=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR;
    uint64_t ordinary=read|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_REMOVE_DIR|LANDLOCK_ACCESS_FS_REMOVE_FILE|LANDLOCK_ACCESS_FS_MAKE_DIR|LANDLOCK_ACCESS_FS_MAKE_REG|LANDLOCK_ACCESS_FS_MAKE_SYM|LANDLOCK_ACCESS_FS_REFER|LANDLOCK_ACCESS_FS_TRUNCATE;
    struct gram_landlock_ruleset_attr attr={.handled_access_fs=(1ULL<<16)-1,.scoped=LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET|LANDLOCK_SCOPE_SIGNAL};
    int fd=(int)syscall(SYS_landlock_create_ruleset,&attr,sizeof(attr),0);
    if(fd<0) die("Landlock ruleset failed");
    rule(fd,"/usr",read|LANDLOCK_ACCESS_FS_EXECUTE,0);
    rule(fd,"/bin",read|LANDLOCK_ACCESS_FS_EXECUTE,1);
    rule(fd,"/lib",read|LANDLOCK_ACCESS_FS_EXECUTE,1);
    rule(fd,"/lib64",read|LANDLOCK_ACCESS_FS_EXECUTE,1);
    rule(fd,argv[2],read|LANDLOCK_ACCESS_FS_EXECUTE,0);
    rule(fd,argv[1],ordinary,0);
    for(int i=0;i<script_count;i++) script_rule(fd,argv[1],argv[4+i*2]);
    rule(fd,"/home/gram-sandbox",ordinary,1);
    rule(fd,"/proc",read,0);
    /* Outer sandbox supplies only null/zero/random/urandom and private pts. */
    rule(fd,"/dev",read|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_IOCTL_DEV,0);
    if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_DUMPABLE,0,0,0,0)) die("process hardening failed");
    if(syscall(SYS_landlock_restrict_self,fd,0)) die("Landlock enforce failed");
    if(syscall(SYS_close_range,3U,~0U,0)) die("descriptor closure failed");
    seccomp();
    execv(argv[command],argv+command);
    die("exec failed");
}
