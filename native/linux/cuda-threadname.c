#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
static int comm_path(const char *p) {
 const char *prefix="/proc/self/task/"; size_t n=strlen(prefix);
 if (!p || strncmp(p,prefix,n)) return 0;
 p+=n; const char *start=p; while (*p>='0' && *p<='9') p++;
 return p>start && p-start<=10 && !strcmp(p,"/comm");
}
static FILE *call_open(const char *symbol,const char *path,const char *mode) {
 FILE *(*real_open)(const char *,const char *)=(FILE *(*)(const char *,const char *))dlsym(RTLD_NEXT,symbol);
 if (!real_open) { errno=ENOSYS; return NULL; }
 if (comm_path(path) && mode && (!strcmp(mode,"w") || !strcmp(mode,"wb"))) path="/dev/null";
 return real_open(path,mode);
}
FILE *fopen(const char *path,const char *mode) { return call_open("fopen",path,mode); }
FILE *fopen64(const char *path,const char *mode) { return call_open("fopen64",path,mode); }
