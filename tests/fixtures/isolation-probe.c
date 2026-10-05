#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
static void *thread(void *p) { return p; }
int main(int argc, char **argv) {
    if (argc != 3) return 1;
    int allowed = open(argv[1], O_RDONLY); if (allowed < 0) return 2; close(allowed);
    if (open(argv[2], O_RDONLY) >= 0 || errno != EACCES) return 3;
    if (open(argv[1], O_WRONLY) >= 0 || errno != EACCES) return 4;
    int work = open("scratch.txt", O_CREAT | O_WRONLY, 0600); if (work < 0) return 5; close(work);
    if (socket(AF_INET, SOCK_DGRAM, 0) >= 0 || errno != EPERM) return 6;
    int sock = socket(AF_INET, SOCK_STREAM, 0); if (sock < 0) return 7;
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(443), .sin_addr.s_addr = htonl(0x7f000001) };
    if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) >= 0 || errno != EACCES) return 8; close(sock);
    if (fork() >= 0 || errno != EPERM) return 9;
    pthread_t id; if (pthread_create(&id, NULL, thread, NULL) || pthread_join(id, NULL)) return 10;
    if (malloc((size_t)1024*1024*1024) != NULL) return 11;
    puts("fixture isolation checks passed"); return 0;
}
