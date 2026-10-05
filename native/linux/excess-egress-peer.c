#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>

struct outcome {
  const char *code;
  int socket_valid;
  int uid_match;
  int peer_ns_readable;
  int expected_ns_enabled;
  int expected_ns_match;
  int same_broker_namespace;
  pid_t pid;
  uid_t uid;
  uintmax_t peer_dev;
  uintmax_t peer_ino;
  uintmax_t broker_dev;
  uintmax_t broker_ino;
};

static int parse_decimal(const char *text, uintmax_t *value) {
  if (text == NULL || text[0] == '\0' || (text[0] == '0' && text[1] != '\0')) return 0;
  uintmax_t result = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; ++p) {
    if (*p < '0' || *p > '9') return 0;
    unsigned digit = (unsigned)(*p - '0');
    if (result > (UINTMAX_MAX - digit) / 10) return 0;
    result = result * 10 + digit;
  }
  *value = result;
  return 1;
}

static int stat_namespace(const char *path, struct stat *info) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  int ok = fstat(fd, info) == 0;
  (void)close(fd);
  return ok;
}

static void emit(const struct outcome *result) {
  printf("{\"code\":\"%s\",\"socket_valid\":%s,\"uid_match\":%s,"
         "\"peer_ns_readable\":%s,\"expected_ns_enabled\":%s,"
         "\"expected_ns_match\":%s,\"same_broker_namespace\":%s,"
         "\"peer_pid\":%jd,\"peer_uid\":%ju,\"peer_net_dev\":\"%ju\","
         "\"peer_net_ino\":\"%ju\",\"broker_net_dev\":\"%ju\","
         "\"broker_net_ino\":\"%ju\"}\n",
         result->code, result->socket_valid ? "true" : "false",
         result->uid_match ? "true" : "false",
         result->peer_ns_readable ? "true" : "false",
         result->expected_ns_enabled ? "true" : "false",
         result->expected_ns_match ? "true" : "false",
         result->same_broker_namespace ? "true" : "false",
         (intmax_t)result->pid, (uintmax_t)result->uid,
         result->peer_dev, result->peer_ino, result->broker_dev, result->broker_ino);
}

int main(int argc, char **argv) {
  struct outcome result = {
    .code = "INVALID_ARGUMENTS", .socket_valid = 0, .uid_match = 0,
    .peer_ns_readable = 0, .expected_ns_enabled = 0,
    .expected_ns_match = 0, .same_broker_namespace = 0,
    .pid = 0, .uid = 0, .peer_dev = 0, .peer_ino = 0,
    .broker_dev = 0, .broker_ino = 0
  };
  uintmax_t expected_dev = 0, expected_ino = 0;
  if (argc != 3 || strncmp(argv[1], "--expected-net-dev=", 19) != 0 ||
      strncmp(argv[2], "--expected-net-ino=", 19) != 0 ||
      !parse_decimal(argv[1] + 19, &expected_dev) ||
      !parse_decimal(argv[2] + 19, &expected_ino) ||
      (uintmax_t)(dev_t)expected_dev != expected_dev ||
      (uintmax_t)(ino_t)expected_ino != expected_ino) {
    emit(&result);
    return 0;
  }
  result.expected_ns_enabled = 1;

  int type = 0;
  socklen_t type_length = (socklen_t)sizeof(type);
  struct sockaddr_un local_address, peer_address;
  socklen_t local_length = (socklen_t)sizeof(local_address);
  socklen_t peer_length = (socklen_t)sizeof(peer_address);
  struct ucred credentials;
  socklen_t credentials_length = (socklen_t)sizeof(credentials);
  if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &type_length) != 0 ||
      type != SOCK_STREAM ||
      getsockname(3, (struct sockaddr *)&local_address, &local_length) != 0 ||
      getpeername(3, (struct sockaddr *)&peer_address, &peer_length) != 0 ||
      local_address.sun_family != AF_UNIX || peer_address.sun_family != AF_UNIX ||
      getsockopt(3, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_length) != 0) {
    result.code = "INVALID_SOCKET";
    emit(&result);
    return 0;
  }
  result.socket_valid = 1;
  result.pid = credentials.pid;
  result.uid = credentials.uid;
  result.uid_match = credentials.uid == getuid();

  struct stat broker_namespace;
  if (!stat_namespace("/proc/self/ns/net", &broker_namespace)) {
    result.code = "BROKER_NAMESPACE_UNAVAILABLE";
    emit(&result);
    return 0;
  }
  result.broker_dev = (uintmax_t)broker_namespace.st_dev;
  result.broker_ino = (uintmax_t)broker_namespace.st_ino;
  result.same_broker_namespace = expected_dev == result.broker_dev && expected_ino == result.broker_ino;

  char peer_path[64];
  int path_length = snprintf(peer_path, sizeof(peer_path), "/proc/%jd/ns/net", (intmax_t)credentials.pid);
  struct stat peer_namespace;
  if (path_length <= 0 || (size_t)path_length >= sizeof(peer_path) ||
      !stat_namespace(peer_path, &peer_namespace)) {
    result.code = "PEER_NAMESPACE_UNAVAILABLE";
    emit(&result);
    return 0;
  }
  result.peer_ns_readable = 1;
  result.peer_dev = (uintmax_t)peer_namespace.st_dev;
  result.peer_ino = (uintmax_t)peer_namespace.st_ino;
  result.expected_ns_match = result.peer_dev == expected_dev && result.peer_ino == expected_ino;

  if (!result.uid_match) result.code = "PEER_UID_MISMATCH";
  else if (result.same_broker_namespace) result.code = "EXPECTED_NAMESPACE_IS_BROKER";
  else if (!result.expected_ns_match) result.code = "PEER_NAMESPACE_MISMATCH";
  else result.code = "ACCEPT";
  emit(&result);
  return 0;
}
