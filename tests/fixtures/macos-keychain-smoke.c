/* Synthetic credential, in an explicitly selected private fixture keychain. */
#include <Security/Security.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef BUILD_VERSION
#define BUILD_VERSION 1
#endif
static const volatile unsigned build_version = BUILD_VERSION;
static int done(int passed) { puts(passed ? "pass" : "fail"); return passed ? 0 : 1; }
static int private_keychain(const char *path) {
    char parent[PATH_MAX], resolved[PATH_MAX]; struct stat st;
    if (!path || path[0] != '/' || strlen(path) >= sizeof(parent)) return 0;
    if (lstat(path, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 0777) != 0600) return 0;
    strcpy(parent, path); char *slash = strrchr(parent, '/'); if (!slash || slash == parent || !slash[1]) return 0;
    *slash = 0;
    return realpath(parent, resolved) && !strcmp(parent, resolved) && !lstat(parent, &st) && S_ISDIR(st.st_mode) && st.st_uid == getuid() && (st.st_mode & 0777) == 0700;
}
int main(int argc, const char *argv[]) {
    if (argc != 4 || !private_keychain(argv[1]) || strlen(argv[3]) == 0 || strlen(argv[3]) > 256 || !build_version) return done(0);
    int creating = !strcmp(argv[2], "create");
    if (!creating && strcmp(argv[2], "read")) return done(0);
    if (SecKeychainSetUserInteractionAllowed(false)) return done(0);
    SecKeychainRef keychain = NULL;
    if (SecKeychainOpen(argv[1], &keychain)) return done(0);
    const char account[] = "readymade-signing-smoke", secret[] = "synthetic-readymade-keychain-smoke";
    OSStatus status;
    if (creating) {
        SecAccessRef access = NULL;
        status = SecAccessCreate(CFSTR("Readymade synthetic signing fixture"), NULL, &access);
        if (!status) {
            SecKeychainAttribute attributes[] = {
                {kSecServiceItemAttr, (UInt32)strlen(argv[3]), (void *)argv[3]},
                {kSecAccountItemAttr, (UInt32)(sizeof(account) - 1), (void *)account}
            };
            SecKeychainAttributeList list = {2, attributes};
            status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, (UInt32)(sizeof(secret) - 1), secret, keychain, access, NULL);
            CFRelease(access);
        }
    } else {
        UInt32 size = 0; void *bytes = NULL;
        status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(argv[3]), argv[3], (UInt32)(sizeof(account) - 1), account, &size, &bytes, NULL);
        if (!status && (size != sizeof(secret) - 1 || memcmp(bytes, secret, size))) status = errSecDecode;
        if (bytes) SecKeychainItemFreeContent(NULL, bytes);
    }
    CFRelease(keychain); return done(status == errSecSuccess);
}
