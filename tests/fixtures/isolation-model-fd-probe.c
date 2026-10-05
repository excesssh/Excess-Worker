#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 1;
    int selected = open(argv[1], O_RDONLY); if (selected < 0) return 2;
    unsigned char byte; if (read(selected, &byte, 1) != 1) return 3;
    close(selected);
    if (open(argv[2], O_RDONLY) >= 0 || errno != EACCES) return 4;
    if (open(argv[1], O_WRONLY) >= 0 || errno != EACCES) return 5;
    puts("selected read-only model handle accessible; unselected file denied");
    return 0;
}
