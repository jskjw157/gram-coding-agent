#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc,char **argv) {
 if(argc!=2)return 3;
 const char *op=argv[1]; long result=-2; int expected=EPERM;
 if(!strncmp(op,"fd:",3)) { expected=EBADF;result=fcntl(atoi(op+3),F_GETFD); }
 else if(!strcmp(op,"socketpair")){int pair[2];return socketpair(AF_UNIX,SOCK_STREAM,0,pair)?1:0;}
 else if(!strcmp(op,"socket"))result=syscall(SYS_socket,AF_INET,SOCK_STREAM,0);
 else if(!strcmp(op,"vsock"))result=syscall(SYS_socket,AF_VSOCK,SOCK_STREAM,0);
 else if(!strcmp(op,"unshare"))result=syscall(SYS_unshare,CLONE_NEWUSER);
 else if(!strcmp(op,"clone_namespace"))result=syscall(SYS_clone,CLONE_NEWUSER,0,0,0,0);
 else if(!strcmp(op,"clone3")){expected=ENOSYS;result=syscall(SYS_clone3,0,0);}
 else if(!strcmp(op,"ptrace"))result=syscall(SYS_ptrace,0,0,0,0);
 else if(!strcmp(op,"process_vm"))result=syscall(SYS_process_vm_readv,getpid(),0,0,0,0,0);
 else if(!strcmp(op,"pidfd_getfd"))result=syscall(SYS_pidfd_getfd,-1,0,0);
 else if(!strcmp(op,"bpf"))result=syscall(SYS_bpf,0,0,0);
 else if(!strcmp(op,"keyring"))result=syscall(SYS_keyctl,0,0,0,0,0);
 else if(!strcmp(op,"perf"))result=syscall(SYS_perf_event_open,0,0,-1,-1,0);
 else if(!strcmp(op,"io_uring"))result=syscall(SYS_io_uring_setup,0,0);
 else if(!strcmp(op,"mount"))result=syscall(SYS_mount,0,0,0,0,0);
 else if(!strcmp(op,"setns"))result=syscall(SYS_setns,-1,0);
 else if(!strcmp(op,"execveat"))result=syscall(SYS_execveat,-1,"",0,0,0);
 else if(!strcmp(op,"unknown"))result=syscall(999999);
 else if(!strcmp(op,"x32"))result=syscall(0x40000000|SYS_getpid);
 else if(!strcmp(op,"prctl_dumpable"))result=prctl(PR_SET_DUMPABLE,1);
 else return 4;
 return result==-1 && errno==expected?0:1;
}
