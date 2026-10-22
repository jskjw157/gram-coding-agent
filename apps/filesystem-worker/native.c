#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/magic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/xattr.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE 2
#endif

#define ATTR_COUNT 64
#define ATTR_BYTES 65536
#define NAME_BYTES 16384
#define JSON_BYTES 262144

struct attribute {
    char *name;
    unsigned char *value;
    size_t length;
};
struct metadata {
    struct stat st;
    size_t count;
    struct attribute attrs[ATTR_COUNT];
};

static void fail(void) { exit(1); }
static void require(int value) { if (!value) fail(); }
static void ext4(int fd) {
    struct statfs st;
    require(fstatfs(fd, &st) == 0 && (unsigned long)st.f_type == EXT4_SUPER_MAGIC);
}
static int stable(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_mode == b->st_mode && a->st_uid == b->st_uid &&
        a->st_gid == b->st_gid && a->st_nlink == b->st_nlink &&
        a->st_size == b->st_size &&
        a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
        a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
        a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
        a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static void regular(int fd, struct stat *st) {
    require(fstat(fd, st) == 0 && S_ISREG(st->st_mode) &&
        st->st_nlink == 1 && !(st->st_mode & (S_ISUID | S_ISGID)));
    ext4(fd);
}
static void metadata_stat(int fd, struct stat *st) {
    require(fstat(fd, st) == 0);
    if (S_ISDIR(st->st_mode)) ext4(fd);
    else regular(fd, st);
}
static int compare_attributes(const void *a, const void *b) {
    const struct attribute *left = a, *right = b;
    return strcmp(left->name, right->name);
}
static void collect(int fd, struct metadata *meta) {
    memset(meta, 0, sizeof(*meta));
    metadata_stat(fd, &meta->st);
    ssize_t length = flistxattr(fd, NULL, 0);
    require(length >= 0 && length <= NAME_BYTES);
    char names[NAME_BYTES + 1];
    if (length) require(flistxattr(fd, names, (size_t)length) == length);
    size_t offset = 0, total = 0;
    while (offset < (size_t)length) {
        size_t remaining = (size_t)length - offset;
        size_t name_length = strnlen(names + offset, remaining);
        require(name_length > 0 && name_length <= 255 && name_length < remaining &&
            meta->count < ATTR_COUNT);
        const char *name = names + offset;
        /* Privileged namespaces cannot be copied safely by this authority.
         * Reject the whole operation rather than silently skipping an xattr. */
        require((!strncmp(name, "user.", 5) && name_length > 5) ||
            !strcmp(name, "system.posix_acl_access") ||
            (S_ISDIR(meta->st.st_mode) && !strcmp(name, "system.posix_acl_default")));
        struct attribute *attr = &meta->attrs[meta->count++];
        attr->name = strdup(name);
        require(attr->name != NULL);
        ssize_t size = fgetxattr(fd, name, NULL, 0);
        require(size >= 0 && (size_t)size <= ATTR_BYTES - total);
        attr->length = (size_t)size;
        total += attr->length;
        attr->value = malloc(attr->length ? attr->length : 1);
        require(attr->value != NULL &&
            fgetxattr(fd, name, attr->value, attr->length) == size);
        offset += name_length + 1;
    }
    qsort(meta->attrs, meta->count, sizeof(meta->attrs[0]), compare_attributes);
    for (size_t i = 1; i < meta->count; ++i)
        require(strcmp(meta->attrs[i - 1].name, meta->attrs[i].name) != 0);
    struct stat after;
    metadata_stat(fd, &after);
    require(stable(&meta->st, &after));
}
static void dispose(struct metadata *meta) {
    for (size_t i = 0; i < meta->count; ++i) {
        free(meta->attrs[i].name);
        free(meta->attrs[i].value);
    }
}
static const char alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static size_t base64(char *out, size_t capacity, const unsigned char *in, size_t length) {
    size_t needed = ((length + 2) / 3) * 4;
    require(needed < capacity);
    size_t used = 0;
    for (size_t i = 0; i < length; i += 3) {
        unsigned value = (unsigned)in[i] << 16;
        if (i + 1 < length) value |= (unsigned)in[i + 1] << 8;
        if (i + 2 < length) value |= in[i + 2];
        out[used++] = alphabet[(value >> 18) & 63];
        out[used++] = alphabet[(value >> 12) & 63];
        out[used++] = i + 1 < length ? alphabet[(value >> 6) & 63] : '=';
        out[used++] = i + 2 < length ? alphabet[value & 63] : '=';
    }
    out[used] = '\0';
    return used;
}
static void append(char *out, size_t *used, const char *text) {
    size_t length = strlen(text);
    require(length < JSON_BYTES - *used);
    memcpy(out + *used, text, length + 1);
    *used += length;
}
static char *serialize(const struct metadata *meta) {
    char *json = malloc(JSON_BYTES);
    require(json != NULL);
    int length = snprintf(json, JSON_BYTES, "{\"mode\":%u,\"uid\":%lu,\"gid\":%lu,\"xattrs\":[",
        (unsigned)(meta->st.st_mode & 07777),
        (unsigned long)meta->st.st_uid, (unsigned long)meta->st.st_gid);
    require(length > 0 && length < JSON_BYTES);
    size_t used = (size_t)length;
    char encoded[((ATTR_BYTES + 2) / 3) * 4 + 1];
    for (size_t i = 0; i < meta->count; ++i) {
        const struct attribute *attr = &meta->attrs[i];
        append(json, &used, i ? ",[\"" : "[\"");
        base64(encoded, sizeof(encoded), (const unsigned char *)attr->name, strlen(attr->name));
        append(json, &used, encoded);
        append(json, &used, "\",\"");
        base64(encoded, sizeof(encoded), attr->value, attr->length);
        append(json, &used, encoded);
        append(json, &used, "\"]");
    }
    append(json, &used, "]}");
    return json;
}
static void output_metadata(const struct metadata *meta) {
    char *json = serialize(meta);
    size_t length = strlen(json);
    size_t capacity = ((length + 2) / 3) * 4 + 2;
    char *encoded = malloc(capacity);
    require(encoded != NULL);
    size_t used = base64(encoded, capacity, (const unsigned char *)json, length);
    encoded[used++] = '\n';
    size_t offset = 0;
    while (offset < used) {
        ssize_t count = write(STDOUT_FILENO, encoded + offset, used - offset);
        require(count > 0);
        offset += (size_t)count;
    }
    free(encoded);
    free(json);
}
static void copy_permissions(void) {
    struct metadata source, destination, after;
    collect(3, &source);
    collect(4, &destination);
    require(S_ISREG(source.st.st_mode) && S_ISREG(destination.st.st_mode));
    require(source.st.st_dev != destination.st.st_dev ||
        source.st.st_ino != destination.st.st_ino);
    /* No chown, privileged ownership impersonation or privilege bits. */
    require(source.st.st_uid == destination.st.st_uid &&
        source.st.st_gid == destination.st.st_gid &&
        destination.st.st_uid == geteuid());
    int flags = fcntl(4, F_GETFL);
    require(flags >= 0 && (flags & O_ACCMODE) != O_RDONLY);
    for (size_t i = 0; i < destination.count; ++i)
        require(fremovexattr(4, destination.attrs[i].name) == 0);
    require(fchmod(4, source.st.st_mode & 07777) == 0);
    for (size_t i = 0; i < source.count; ++i) {
        const struct attribute *attr = &source.attrs[i];
        require(fsetxattr(4, attr->name, attr->value, attr->length, 0) == 0);
    }
    collect(4, &after);
    char *expected = serialize(&source), *actual = serialize(&after);
    require(strcmp(expected, actual) == 0);
    struct stat current;
    regular(3, &current);
    require(stable(&source.st, &current));
    require(fsync(4) == 0);
    output_metadata(&after);
    free(expected);
    free(actual);
    dispose(&source);
    dispose(&destination);
    dispose(&after);
}
static void leaf(const char *name) {
    size_t length = strlen(name);
    require(length > 0 && length <= 255 && strcmp(name, ".") && strcmp(name, ".."));
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)name[i];
        require(c >= 32 && c != 127 && c != '/' && c != '\\' && c != ':');
    }
}
static void rename_fixed(const char *from, const char *to, unsigned flags) {
    leaf(from);
    leaf(to);
    struct stat source, destination;
    require(fstat(3, &source) == 0 && S_ISDIR(source.st_mode) &&
        fstat(4, &destination) == 0 && S_ISDIR(destination.st_mode));
    ext4(3);
    ext4(4);
    require(syscall(SYS_renameat2, 3, from, 4, to, flags) == 0);
    require(write(STDOUT_FILENO, "OK\n", 3) == 3);
}
int main(int argc, char **argv) {
#if !defined(__x86_64__) || defined(__ILP32__)
#error Only native Linux x86_64 is supported
#endif
    require(getuid() != 0 && getuid() == geteuid() && getgid() == getegid());
    if (argc == 2 && !strcmp(argv[1], "metadata")) {
        struct metadata meta;
        collect(3, &meta);
        output_metadata(&meta);
        dispose(&meta);
    } else if (argc == 2 && !strcmp(argv[1], "copy-permissions")) {
        copy_permissions();
    } else if (argc == 4 && !strcmp(argv[1], "exchange")) {
        rename_fixed(argv[2], argv[3], RENAME_EXCHANGE);
    } else if (argc == 4 && !strcmp(argv[1], "noreplace")) {
        rename_fixed(argv[2], argv[3], RENAME_NOREPLACE);
    } else {
        fail();
    }
    return 0;
}
