/* HAAR laboratory inspection helper: metadata only on inherited fd 3.
 * No path argument, file read, network, privilege change or ACL mutation.
 * Root/helper provenance is established by its caller, not by this program.
 */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

static int acl_safe(acl_t acl) {
    if (acl_valid(acl) != 0) return 0;
    acl_permset_mask_t known = 0;
    if (acl_maximal_permset_mask_np(&known) != 0) return 0;
    const acl_permset_mask_t writes = ACL_WRITE_DATA | ACL_APPEND_DATA | ACL_DELETE |
        ACL_DELETE_CHILD | ACL_WRITE_ATTRIBUTES | ACL_WRITE_EXTATTRIBUTES |
        ACL_WRITE_SECURITY | ACL_CHANGE_OWNER;
    for (int n = 0; n <= ACL_MAX_ENTRIES; n++) {
        acl_entry_t entry = NULL;
        errno = 0;
        const int result = acl_get_entry(acl, n == 0 ? ACL_FIRST_ENTRY : ACL_NEXT_ENTRY, &entry);
        /* On Darwin, the end of a valid ACL uses EINVAL, not POSIX return 0. */
        if (result == -1) return errno == EINVAL;
        if (result != 0 || n == ACL_MAX_ENTRIES) return 0;
        acl_tag_t tag = ACL_UNDEFINED_TAG;
        acl_permset_mask_t permissions = 0;
        if (acl_get_tag_type(entry, &tag) != 0 || acl_get_permset_mask_np(entry, &permissions) != 0 ||
            (permissions & ~known) != 0) return 0;
        if (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) return 0;
        /* Conservative: reject every allow-write ACE regardless of principal,
         * ordering or inheritance. Restrictive deny entries are not removed. */
        if (tag == ACL_EXTENDED_ALLOW && (permissions & writes) != 0) return 0;
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argv;
    filesec_t security = NULL;
    acl_t acl = NULL;
    struct stat info;
    int present = 0;
    int safe = 0;
    if (argc != 1 || (security = filesec_init()) == NULL) goto error;
    if (fstatx_np(3, &info, security) != 0 || (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode))) goto error;
    if (filesec_query_property(security, FILESEC_ACL, &present) != 0) goto error;
    if (present) {
        if (filesec_get_property(security, FILESEC_ACL, &acl) != 0 || acl == NULL) goto error;
        safe = acl_safe(acl);
    } else {
        safe = 1;
    }
    printf("{\"schemaVersion\":1,\"safe\":%s,\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\"}\n",
        safe ? "true" : "false", (uintmax_t)info.st_dev, (uintmax_t)info.st_ino);
    if (acl != NULL) acl_free(acl);
    filesec_free(security);
    return 0;
error:
    if (acl != NULL) acl_free(acl);
    if (security != NULL) filesec_free(security);
    puts("{\"schemaVersion\":1,\"safe\":false}");
    return 2;
}
