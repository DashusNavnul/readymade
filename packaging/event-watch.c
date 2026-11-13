/*
 * event-watch: how long a ship's events run, read from outside and read-only.
 *
 *   event-watch --shm <king pid> <seconds> <limit ms>
 *   event-watch --file <path> <seconds> <limit ms>      (the same layout in a plain file; for tests)
 *
 * Every Urbit 4.x runtime keeps the Hoon labels (%spin hints) of the code now running in a 16 KiB shared
 * page named "/spin_stack_page_<king pid>" (vere pkg/noun/trace.c, u3t_sstack_push): a 4-byte write
 * offset, a 4-byte overflow count, then each label's bytes followed by its 4-byte length, with "root" always
 * at the bottom. Only "root" means the worker is between events. This program samples that page every
 * 100 microseconds, cuts the samples into events, and prints:
 *
 *   watched <us> events <n> busy <us> longest <us> over <n> unreadable <n>
 *   slow <start ms> <length us> <label>><label>...     (each event over the limit, at most 32, with the
 *                                                       label stack it spent most of its time under)
 *
 * It never writes to the page and sends nothing to the ship. A sample torn by a concurrent write is
 * skipped and counted as unreadable.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define PAGE 16384
#define DATA (PAGE - 8)
#define PATH_MAX_BYTES 600
#define STACKS 16
#define SLOW_MAX 32

typedef struct {char path[PATH_MAX_BYTES + 1]; uint64_t ns;} stack_time;
typedef struct {uint64_t start, ns; char path[PATH_MAX_BYTES + 1];} slow_event;

static uint64_t now_ns(void) {struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000000u + (uint64_t)t.tv_nsec;}

/* Decode one copy of the page into "label>label" without the root label. Returns the label count (0 when
 * torn or inconsistent, so it is skipped), and sets *idle when only the root label is on the stack. */
static int decode(const unsigned char *page, char *out, int *idle) {
  uint32_t off, fow; memcpy(&off, page, 4); memcpy(&fow, page + 4, 4);
  if (off > DATA || off < 8) return 0;
  const unsigned char *dat = page + 8;
  uint32_t ends[512]; int n = 0; uint32_t p = off;
  while (p > 0) {
    if (p < 4 || n == 512) return 0;
    uint32_t len; memcpy(&len, dat + p - 4, 4); p -= 4;
    if (len == 0 || len > p || len > 200) return 0;
    ends[n++] = p; p -= len;
  }
  size_t w = 0; out[0] = '\0';
  for (int i = n - 2; i >= 0; i--) {                     /* n - 1 is the bottom: root */
    uint32_t end = ends[i], len; memcpy(&len, dat + end, 4);
    if (w && w < PATH_MAX_BYTES) out[w++] = '>';
    for (uint32_t k = end - len; k < end && w < PATH_MAX_BYTES; k++) out[w++] = (dat[k] > 32 && dat[k] < 127 && dat[k] != '>') ? (char)dat[k] : '?';
  }
  if (fow && w < PATH_MAX_BYTES - 12) w += (size_t)snprintf(out + w, PATH_MAX_BYTES + 1 - w, ">+%u", fow);
  out[w] = '\0';
  *idle = (n == 1 && fow == 0);
  return n;
}

int main(int argc, char **argv) {
  if (argc != 5) {fputs("usage: event-watch --shm <king pid> | --file <path>, <seconds> <limit ms>\n", stderr); return 2;}
  char *end; double seconds = strtod(argv[3], &end); if (*end || !(seconds > 0 && seconds <= 600)) return 2;
  long limit_ms = strtol(argv[4], &end, 10); if (*end || limit_ms < 1 || limit_ms > 60000) return 2;
  int fd;
  if (!strcmp(argv[1], "--shm")) {
    long pid = strtol(argv[2], &end, 10); if (*end || pid < 1 || pid > 99999999) return 2;
    char name[64]; snprintf(name, sizeof name, "/spin_stack_page_%ld", pid);
    fd = shm_open(name, O_RDONLY, 0);
  } else if (!strcmp(argv[1], "--file")) fd = open(argv[2], O_RDONLY);
  else return 2;
  if (fd < 0) {printf("unavailable %d\n", errno); return 3;}
  const volatile unsigned char *map = mmap(NULL, PAGE, PROT_READ, MAP_SHARED, fd, 0);
  close(fd);
  if (map == MAP_FAILED) {printf("unavailable %d\n", errno); return 3;}

  static unsigned char page[PAGE]; static char path[PATH_MAX_BYTES + 1], cur[PATH_MAX_BYTES + 1];
  static stack_time stacks[STACKS]; static slow_event slow[SLOW_MAX];
  const uint64_t limit = (uint64_t)limit_ms * 1000000u, t0 = now_ns(), stop = t0 + (uint64_t)(seconds * 1e9);
  uint64_t events = 0, busy = 0, longest = 0, over = 0, unreadable = 0, since = t0, event_start = 0;
  int cur_idle = 1, open_event = 0, nstacks = 0, nslow = 0; cur[0] = '\0';
  const struct timespec rest = {0, 100000};

  for (;;) {
    uint64_t t = now_ns(); int done = t >= stop, idle = 1;
    if (!done) {
      memcpy(page, (const void *)map, 8);
      uint32_t off; memcpy(&off, page, 4);
      if (off > DATA) {unreadable++; nanosleep(&rest, NULL); continue;}
      memcpy(page + 8, (const void *)(map + 8), off);
      if (!decode(page, path, &idle)) {unreadable++; nanosleep(&rest, NULL); continue;}
      if (idle == cur_idle && !strcmp(path, cur)) {nanosleep(&rest, NULL); continue;}
    }
    if (!cur_idle) {                                      /* time since the last change belongs to cur */
      if (!open_event) {open_event = 1; event_start = since; nstacks = 0;}
      int i = 0; while (i < nstacks && strcmp(stacks[i].path, cur)) i++;
      if (i == nstacks && nstacks < STACKS) {strcpy(stacks[nstacks].path, cur); stacks[nstacks++].ns = 0;}
      if (i < nstacks) stacks[i].ns += t - since;
    }
    if (open_event && (idle || done)) {
      uint64_t length = t - event_start; events++; busy += length; if (length > longest) longest = length;
      if (length > limit) {
        over++;
        if (nslow < SLOW_MAX) {
          int top = 0; for (int i = 1; i < nstacks; i++) if (stacks[i].ns > stacks[top].ns) top = i;
          slow[nslow].start = event_start - t0; slow[nslow].ns = length; strcpy(slow[nslow].path, nstacks ? stacks[top].path : "?"); nslow++;
        }
      }
      open_event = 0;
    }
    if (done) break;
    strcpy(cur, path); cur_idle = idle; since = t;
    nanosleep(&rest, NULL);
  }
  printf("watched %llu events %llu busy %llu longest %llu over %llu unreadable %llu\n", (unsigned long long)((stop - t0) / 1000),
    (unsigned long long)events, (unsigned long long)(busy / 1000), (unsigned long long)(longest / 1000), (unsigned long long)over, (unsigned long long)unreadable);
  for (int i = 0; i < nslow; i++) printf("slow %llu %llu %s\n", (unsigned long long)(slow[i].start / 1000000), (unsigned long long)(slow[i].ns / 1000), slow[i].path[0] ? slow[i].path : "?");
  return 0;
}
