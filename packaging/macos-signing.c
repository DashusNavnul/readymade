/* Dedicated build keychain only. No user credential items or global trust. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static char password[66];
static void erase(void *bytes, size_t size) { volatile unsigned char *p = bytes; while (size--) *p++ = 0; }
static void fail(const char *stage, OSStatus status) {
    erase(password, sizeof(password));
    fprintf(stderr, "%s:%ld\n", stage, (long)status);
    exit(1);
}
static void check(const char *stage, OSStatus status) { if (status) fail(stage, status); }
static void require(int condition, const char *stage) { if (!condition) fail(stage, errSecParam); }
static void private_parent(const char *path) {
    char parent[PATH_MAX], resolved[PATH_MAX]; struct stat st;
    require(path && path[0] == '/' && strlen(path) < sizeof(parent), "path");
    strcpy(parent, path); char *slash = strrchr(parent, '/');
    require(slash && slash != parent && slash[1] && strcmp(slash + 1, ".") && strcmp(slash + 1, ".."), "path");
    *slash = 0;
    require(realpath(parent, resolved) && !strcmp(parent, resolved), "parent");
    require(!lstat(parent, &st) && S_ISDIR(st.st_mode) && st.st_uid == getuid() && (st.st_mode & 0777) == 0700, "parent");
}
static struct stat private_file(const char *path) {
    struct stat st; private_parent(path);
    require(!lstat(path, &st) && S_ISREG(st.st_mode) && st.st_uid == getuid() && st.st_nlink == 1 && (st.st_mode & 0777) == 0600, "file");
    return st;
}
static CFDataRef read_p12(const char *path) {
    struct stat before = private_file(path), after;
    require(before.st_size > 0 && before.st_size <= 1048576, "p12-size");
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    require(fd >= 0 && !fstat(fd, &after) && before.st_dev == after.st_dev && before.st_ino == after.st_ino, "p12-open");
    UInt8 *bytes = malloc((size_t)before.st_size); require(bytes != NULL, "allocate");
    size_t total = 0;
    while (total < (size_t)before.st_size) {
        ssize_t count = read(fd, bytes + total, (size_t)before.st_size - total);
        if (count < 0 && errno == EINTR) continue;
        require(count > 0, "p12-read"); total += (size_t)count;
    }
    require(!close(fd), "p12-close");
    CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)total);
    erase(bytes, total); free(bytes); require(data != NULL, "allocate"); return data;
}
static void own_search_entry(SecKeychainRef own, int append) {
    CFArrayRef current = NULL; check("search-read", SecKeychainCopySearchList(&current));
    CFMutableArrayRef kept = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks); require(kept != NULL, "allocate");
    int found = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(current); i++) {
        CFTypeRef item = CFArrayGetValueAtIndex(current, i);
        if (CFEqual(item, own)) { found = 1; if (append) CFArrayAppendValue(kept, item); }
        else CFArrayAppendValue(kept, item);
    }
    if (append && !found) CFArrayAppendValue(kept, own);
    if ((append && !found) || (!append && found)) check("search-own-entry", SecKeychainSetSearchList(kept));
    CFRelease(kept); CFRelease(current);
}
static SecAccessRef signing_access(void) {
    SecTrustedApplicationRef codesign = NULL; SecAccessRef access = NULL;
    check("codesign-app", SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &codesign));
    const void *apps[] = {codesign};
    CFArrayRef allowed = CFArrayCreate(NULL, apps, 1, &kCFTypeArrayCallBacks); require(allowed != NULL, "allocate");
    check("signing-access", SecAccessCreate(CFSTR("Readymade build signing"), allowed, &access));
    /* Apple's partition ACL encoding: hexadecimal XML plist, not a password. */
    const void *partitions[] = {CFSTR("apple:")};
    CFArrayRef partition_list = CFArrayCreate(NULL, partitions, 1, &kCFTypeArrayCallBacks);
    require(partition_list != NULL, "allocate");
    const void *keys[] = {CFSTR("Partitions")}, *values[] = {partition_list};
    CFDictionaryRef plist = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    require(plist != NULL, "allocate");
    CFDataRef xml = CFPropertyListCreateData(NULL, plist, kCFPropertyListXMLFormat_v1_0, 0, NULL); require(xml != NULL, "partition-plist");
    CFIndex size = CFDataGetLength(xml); require(size > 0 && size < 8192, "partition-size");
    char hex[16385]; const UInt8 *bytes = CFDataGetBytePtr(xml); const char digits[] = "0123456789abcdef";
    for (CFIndex i = 0; i < size; i++) { hex[2 * i] = digits[bytes[i] >> 4]; hex[2 * i + 1] = digits[bytes[i] & 15]; }
    hex[2 * size] = 0;
    CFStringRef description = CFStringCreateWithCString(NULL, hex, kCFStringEncodingASCII); require(description != NULL, "allocate");
    SecACLRef acl = NULL; check("partition-create", SecACLCreateWithSimpleContents(access, allowed, description, 0, &acl));
    const void *tags[] = {kSecACLAuthorizationPartitionID};
    CFArrayRef authorizations = CFArrayCreate(NULL, tags, 1, &kCFTypeArrayCallBacks); require(authorizations != NULL, "allocate");
    check("partition-authorization", SecACLUpdateAuthorizations(acl, authorizations));
    CFRelease(authorizations); CFRelease(acl); CFRelease(description); CFRelease(xml); CFRelease(plist);
    CFRelease(partition_list); CFRelease(allowed); CFRelease(codesign); return access;
}
int main(int argc, const char *argv[]) {
    require(argc == 3 || argc == 4, "arguments");
    int creating = !strcmp(argv[1], "create");
    int unlocking = !strcmp(argv[1], "unlock"), activating = !strcmp(argv[1], "activate"), deactivating = !strcmp(argv[1], "deactivate");
    require((creating && argc == 4) || ((unlocking || activating || deactivating) && argc == 3), "arguments");
    private_parent(argv[2]); umask(0077);
    if (creating) {
        struct stat st; char sibling[PATH_MAX];
        require(strlen(argv[2]) + 3 < sizeof(sibling), "path");
        require(lstat(argv[2], &st) < 0 && errno == ENOENT, "exists");
        snprintf(sibling, sizeof(sibling), "%s-db", argv[2]);
        require(lstat(sibling, &st) < 0 && errno == ENOENT, "exists");
        (void)private_file(argv[3]);
    } else (void)private_file(argv[2]);
    if (creating || unlocking) {
        require(fgets(password, sizeof(password), stdin) && strlen(password) == 65 && password[64] == '\n' && fgetc(stdin) == EOF, "password-input");
        for (size_t i = 0; i < 64; i++) require((password[i] >= '0' && password[i] <= '9') || (password[i] >= 'a' && password[i] <= 'f'), "password-input");
        password[64] = 0;
    }
    check("disable-interaction", SecKeychainSetUserInteractionAllowed(false));
    SecKeychainRef keychain = NULL;
    if (!creating) {
        check("open", SecKeychainOpen(argv[2], &keychain));
        if (unlocking) check("unlock", SecKeychainUnlock(keychain, 64, password, true));
        else own_search_entry(keychain, activating);
    } else {
        CFDataRef data = read_p12(argv[3]); SecAccessRef access = signing_access();
        CFStringRef phrase = CFStringCreateWithCString(NULL, password, kCFStringEncodingASCII); require(phrase != NULL, "allocate");
        check("create", SecKeychainCreate(argv[2], 64, password, false, NULL, &keychain));
        own_search_entry(keychain, 0);
        SecExternalFormat format = kSecFormatPKCS12; SecExternalItemType type = kSecItemTypeAggregate;
        SecItemImportExportKeyParameters parameters = {0}; parameters.version = SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION;
        parameters.passphrase = phrase; parameters.accessRef = access;
        CFArrayRef items = NULL;
        check("import", SecItemImport(data, CFSTR(".p12"), &format, &type, kSecKeyImportOnlyOne, &parameters, keychain, &items));
        require(items && CFArrayGetCount(items) == 1 && CFGetTypeID(CFArrayGetValueAtIndex(items, 0)) == SecIdentityGetTypeID(), "import-identity");
        own_search_entry(keychain, 0);
        CFRelease(items); CFRelease(phrase); CFRelease(access); CFRelease(data);
    }
    CFRelease(keychain); erase(password, sizeof(password)); return 0;
}
