/**
 * One-Shot Token LD_PRELOAD Library
 *
 * Intercepts getenv() calls for sensitive token environment variables.
 * On first access, caches the value in memory and unsets from environment.
 * Subsequent calls return the cached value, so the process can read tokens
 * multiple times while /proc/self/environ no longer exposes them.
 *
 * Configuration:
 *   AWF_ONE_SHOT_TOKENS - Comma-separated list of token names to protect
 *   If not set, uses built-in defaults
 *
 *   AWF_ONE_SHOT_TOKEN_DEBUG - Enable debug logging output (default: off)
 *   Set to "1" or "true" to enable logging. Logging is silent by default.
 *
 * Build hardening:
 *   Default token names are XOR-obfuscated to prevent cleartext extraction
 *   via strings(1) or objdump. Internal symbols use hidden visibility.
 *   Binary should be stripped after compilation (see build.sh / Dockerfile).
 *
 * Compile: gcc -shared -fPIC -fvisibility=hidden -o one-shot-token.so one-shot-token.c -ldl
 * Usage: LD_PRELOAD=/path/to/one-shot-token.so ./your-program
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdio.h>
#include <ctype.h>

/* --------------------------------------------------------------------------
 * Obfuscated default token names
 *
 * Token names are XOR-encoded so they do not appear as cleartext in the
 * .rodata section.  This is NOT cryptographic protection -- a determined
 * attacker can reverse the XOR.  The goal is to prevent trivial discovery
 * via `strings`, `objdump -s -j .rodata`, or similar reconnaissance.
 *
 * Re-generate with: containers/agent/one-shot-token/encode-tokens.sh
 * -------------------------------------------------------------------------- */

#define OBF_KEY 0x5A

/* Entry in the obfuscated defaults table */
struct obf_entry {
    const unsigned char *data;
    size_t len;
};

/* --- BEGIN GENERATED OBFUSCATED DEFAULTS (key=0x5A) --- */
/* Re-generate with: containers/agent/one-shot-token/encode-tokens.sh */
#define NUM_DEFAULT_TOKENS 11

static const unsigned char OBF_0[] = { 0x19, 0x15, 0x0a, 0x13, 0x16, 0x15, 0x0e, 0x05, 0x1d, 0x13, 0x0e, 0x12, 0x0f, 0x18, 0x05, 0x0e, 0x15, 0x11, 0x1f, 0x14 }; /* length=20 */
static const unsigned char OBF_1[] = { 0x1d, 0x13, 0x0e, 0x12, 0x0f, 0x18, 0x05, 0x0e, 0x15, 0x11, 0x1f, 0x14 }; /* length=12 */
static const unsigned char OBF_2[] = { 0x1d, 0x12, 0x05, 0x0e, 0x15, 0x11, 0x1f, 0x14 }; /* length=8 */
static const unsigned char OBF_3[] = { 0x1d, 0x13, 0x0e, 0x12, 0x0f, 0x18, 0x05, 0x1b, 0x0a, 0x13, 0x05, 0x0e, 0x15, 0x11, 0x1f, 0x14 }; /* length=16 */
static const unsigned char OBF_4[] = { 0x1d, 0x13, 0x0e, 0x12, 0x0f, 0x18, 0x05, 0x0a, 0x1b, 0x0e }; /* length=10 */
static const unsigned char OBF_5[] = { 0x1d, 0x12, 0x05, 0x1b, 0x19, 0x19, 0x1f, 0x09, 0x09, 0x05, 0x0e, 0x15, 0x11, 0x1f, 0x14 }; /* length=15 */
static const unsigned char OBF_6[] = { 0x15, 0x0a, 0x1f, 0x14, 0x1b, 0x13, 0x05, 0x1b, 0x0a, 0x13, 0x05, 0x11, 0x1f, 0x03 }; /* length=14 */
static const unsigned char OBF_7[] = { 0x15, 0x0a, 0x1f, 0x14, 0x1b, 0x13, 0x05, 0x11, 0x1f, 0x03 }; /* length=10 */
static const unsigned char OBF_8[] = { 0x1b, 0x14, 0x0e, 0x12, 0x08, 0x15, 0x0a, 0x13, 0x19, 0x05, 0x1b, 0x0a, 0x13, 0x05, 0x11, 0x1f, 0x03 }; /* length=17 */
static const unsigned char OBF_9[] = { 0x19, 0x16, 0x1b, 0x0f, 0x1e, 0x1f, 0x05, 0x1b, 0x0a, 0x13, 0x05, 0x11, 0x1f, 0x03 }; /* length=14 */
static const unsigned char OBF_10[] = { 0x19, 0x15, 0x1e, 0x1f, 0x02, 0x05, 0x1b, 0x0a, 0x13, 0x05, 0x11, 0x1f, 0x03 }; /* length=13 */

static const struct obf_entry OBFUSCATED_DEFAULTS[11] = {
    { OBF_0, sizeof(OBF_0) },
    { OBF_1, sizeof(OBF_1) },
    { OBF_2, sizeof(OBF_2) },
    { OBF_3, sizeof(OBF_3) },
    { OBF_4, sizeof(OBF_4) },
    { OBF_5, sizeof(OBF_5) },
    { OBF_6, sizeof(OBF_6) },
    { OBF_7, sizeof(OBF_7) },
    { OBF_8, sizeof(OBF_8) },
    { OBF_9, sizeof(OBF_9) },
    { OBF_10, sizeof(OBF_10) },
};
/* --- END GENERATED OBFUSCATED DEFAULTS --- */

/**
 * Decode an obfuscated entry into a newly allocated string.
 * Returns NULL on allocation failure.
 */
static char *decode_obf(const struct obf_entry *entry) {
    char *decoded = malloc(entry->len + 1);
    if (decoded == NULL) return NULL;
    for (size_t i = 0; i < entry->len; i++) {
        decoded[i] = (char)(entry->data[i] ^ OBF_KEY);
    }
    decoded[entry->len] = '\0';
    return decoded;
}

/* Maximum number of tokens we can track (for static allocation). This limit
 * balances memory usage with practical needs - 100 tokens should be more than
 * sufficient for any reasonable use case while keeping memory overhead low. */
#define MAX_TOKENS 100

/* Runtime token list (populated from AWF_ONE_SHOT_TOKENS or defaults) */
static char *sensitive_tokens[MAX_TOKENS];
static int num_tokens = 0;

/* Track which tokens have been accessed (one flag per token) */
static int token_accessed[MAX_TOKENS] = {0};

/* Cached token values - stored on first access so subsequent reads succeed
 * even after the variable is unset from the environment. This allows
 * /proc/self/environ to be cleaned while the process can still read tokens. */
static char *token_cache[MAX_TOKENS] = {0};

/* Mutex for thread safety */
static pthread_mutex_t token_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Thread-local recursion guard to prevent deadlock when:
 * 1. secure_getenv("X") acquires token_mutex
 * 2. init_token_list() calls fprintf() for logging
 * 3. glibc's fprintf calls secure_getenv() for locale initialization
 * 4. Our secure_getenv() would try to acquire token_mutex again -> DEADLOCK
 *
 * With this guard, recursive calls from the same thread skip the mutex
 * and pass through directly to the real function. This is safe because
 * the recursive call is always for a non-sensitive variable (locale).
 */
static __thread int in_getenv = 0;

/* Initialization flag */
static int tokens_initialized = 0;

/* Debug logging flag (controlled by AWF_ONE_SHOT_TOKEN_DEBUG environment variable) */
static int debug_enabled = 0;

/* Pointer to the real getenv function */
static char *(*real_getenv)(const char *name) = NULL;

/* Pointer to the real secure_getenv function */
static char *(*real_secure_getenv)(const char *name) = NULL;

/* Resolve real_getenv if not yet resolved (idempotent, no locks needed) */
static void ensure_real_getenv(void) {
    if (real_getenv != NULL) return;
    real_getenv = dlsym(RTLD_NEXT, "getenv");
    if (real_getenv == NULL) {
        fprintf(stderr, "[one-shot-token] FATAL: Could not find real getenv: %s\n", dlerror());
        abort();
    }
}

/* Resolve real_secure_getenv if not yet resolved (idempotent, no locks needed) */
static void ensure_real_secure_getenv(void) {
    if (real_secure_getenv != NULL) return;
    real_secure_getenv = dlsym(RTLD_NEXT, "secure_getenv");
    /* secure_getenv may not be available on all systems - that's OK */
}

/**
 * Check if debug logging is enabled via AWF_ONE_SHOT_TOKEN_DEBUG environment variable.
 * Returns 1 if AWF_ONE_SHOT_TOKEN_DEBUG is set to "1" or "true" (case-insensitive), 0 otherwise.
 *
 * CRITICAL: This function must call the real getenv directly to avoid infinite recursion
 * when checking the debug flag during initialization. The AWF_ONE_SHOT_TOKEN_DEBUG variable
 * is never cached or cleared by this library.
 */
static int is_debug_enabled(void) {
    const char *debug_value = real_getenv("AWF_ONE_SHOT_TOKEN_DEBUG");

    if (debug_value == NULL || debug_value[0] == '\0') {
        return 0;
    }

    /* Check if value is "1" */
    if (strcmp(debug_value, "1") == 0) {
        return 1;
    }

    /* Check if value is "true" (case-insensitive) */
    if (strcasecmp(debug_value, "true") == 0) {
        return 1;
    }

    return 0;
}

/**
 * Initialize the token list from AWF_ONE_SHOT_TOKENS environment variable
 * or use defaults if not set. This is called once at first getenv() call.
 * Note: This function must be called with token_mutex held.
 */
static void init_token_list(void) {
    if (tokens_initialized) {
        return;
    }

    /* Check if debug logging is enabled */
    debug_enabled = is_debug_enabled();

    /* Get the configuration from environment */
    const char *config = real_getenv("AWF_ONE_SHOT_TOKENS");

    if (config != NULL && config[0] != '\0') {
        /* Parse comma-separated token list using strtok_r for thread safety */
        char *config_copy = strdup(config);
        if (config_copy == NULL) {
            fprintf(stderr, "[one-shot-token] ERROR: Failed to allocate memory for token list\n");
            abort();
        }

        char *saveptr = NULL;
        char *token = strtok_r(config_copy, ",", &saveptr);
        while (token != NULL && num_tokens < MAX_TOKENS) {
            /* Trim leading whitespace */
            while (*token && isspace((unsigned char)*token)) token++;

            /* Trim trailing whitespace (only if string is non-empty) */
            size_t token_len = strlen(token);
            if (token_len > 0) {
                char *end = token + token_len - 1;
                while (end > token && isspace((unsigned char)*end)) {
                    *end = '\0';
                    end--;
                }
            }

            if (*token != '\0') {
                sensitive_tokens[num_tokens] = strdup(token);
                if (sensitive_tokens[num_tokens] == NULL) {
                    fprintf(stderr, "[one-shot-token] ERROR: Failed to allocate memory for token name\n");
                    /* Clean up previously allocated tokens */
                    for (int i = 0; i < num_tokens; i++) {
                        free(sensitive_tokens[i]);
                    }
                    free(config_copy);
                    abort();
                }
                num_tokens++;
            }

            token = strtok_r(NULL, ",", &saveptr);
        }

        free(config_copy);

        /* If AWF_ONE_SHOT_TOKENS was set but resulted in zero tokens (e.g., ",,," or whitespace only),
         * fall back to defaults to avoid silently disabling all protection */
        if (num_tokens == 0) {
            if (debug_enabled) {
                fprintf(stderr, "[one-shot-token] WARNING: AWF_ONE_SHOT_TOKENS was set but parsed to zero tokens\n");
                fprintf(stderr, "[one-shot-token] WARNING: Falling back to default token list to maintain protection\n");
            }
            /* num_tokens is already 0 here; assignment is defensive programming for future refactoring */
            num_tokens = 0;
        } else {
            if (debug_enabled) {
                fprintf(stderr, "[one-shot-token] Initialized with %d custom token(s) from AWF_ONE_SHOT_TOKENS\n", num_tokens);
            }
            tokens_initialized = 1;
            return;
        }
    }

    /* Use default token list (when AWF_ONE_SHOT_TOKENS is unset, empty, or parsed to zero tokens) */
    /* Decode obfuscated defaults at runtime */
    for (int i = 0; i < NUM_DEFAULT_TOKENS && num_tokens < MAX_TOKENS; i++) {
        sensitive_tokens[num_tokens] = decode_obf(&OBFUSCATED_DEFAULTS[i]);
        if (sensitive_tokens[num_tokens] == NULL) {
            fprintf(stderr, "[one-shot-token] ERROR: Failed to allocate memory for default token name\n");
            /* Clean up previously allocated tokens */
            for (int j = 0; j < num_tokens; j++) {
                free(sensitive_tokens[j]);
            }
            abort();
        }
        num_tokens++;
    }

    if (debug_enabled) {
        fprintf(stderr, "[one-shot-token] Initialized with %d default token(s)\n", num_tokens);
    }

    tokens_initialized = 1;
}
/**
 * Library constructor - resolves real getenv/secure_getenv at load time.
 *
 * This MUST run before any other library's constructors to prevent a deadlock:
 * if a constructor (e.g., LLVM in rustc) calls getenv() and we lazily call
 * dlsym(RTLD_NEXT) from within our intercepted getenv(), dlsym() deadlocks
 * because the dynamic linker's internal lock is already held during constructor
 * execution. Resolving here (in our LD_PRELOAD'd constructor which runs first)
 * avoids this entirely.
 */
__attribute__((constructor))
static void one_shot_token_init(void) {
    ensure_real_getenv();
    ensure_real_secure_getenv();
}

/* Check if a variable name is a sensitive token */
static int get_token_index(const char *name) {
    if (name == NULL) return -1;

    for (int i = 0; i < num_tokens; i++) {
        if (strcmp(name, sensitive_tokens[i]) == 0) {
            return i;
        }
    }
    return -1;
}

/**
 * Intercepted getenv function
 *
 * For sensitive tokens:
 * - First call: caches the value, unsets from environment, returns cached value
 * - Subsequent calls: returns the cached value from memory
 *
 * This clears tokens from /proc/self/environ while allowing the process
 * to read them multiple times via getenv().
 *
 * For all other variables: passes through to real getenv
 */
__attribute__((visibility("default")))
char *getenv(const char *name) {
    ensure_real_getenv();

    /* Skip interception during recursive calls (e.g., fprintf -> secure_getenv -> getenv) */
    if (in_getenv) {
        return real_getenv(name);
    }
    in_getenv = 1;

    /* Initialize token list on first call (thread-safe) */
    pthread_mutex_lock(&token_mutex);
    if (!tokens_initialized) {
        init_token_list();
    }

    /* Get token index while holding mutex to avoid race with initialization */
    int token_idx = get_token_index(name);

    /* Not a sensitive token - release mutex and pass through */
    if (token_idx < 0) {
        pthread_mutex_unlock(&token_mutex);
        in_getenv = 0;
        return real_getenv(name);
    }

    /* Sensitive token - handle cached access (mutex already held) */
    char *result = NULL;

    if (!token_accessed[token_idx]) {
        /* First access - get the real value and cache it */
        result = real_getenv(name);

        if (result != NULL) {
            /* Cache the value so subsequent reads succeed after unsetenv */
            /* Note: This memory is intentionally never freed - it must persist
             * for the lifetime of the process */
            token_cache[token_idx] = strdup(result);

            /* Unset the variable from the environment so /proc/self/environ is cleared */
            unsetenv(name);

            if (debug_enabled) {
                fprintf(stderr, "[one-shot-token] Token %s accessed and cached (length: %zu)\n",
                        name, strlen(token_cache[token_idx]));
            }

            result = token_cache[token_idx];
        }

        /* Mark as accessed even if NULL (prevents repeated log messages) */
        token_accessed[token_idx] = 1;
    } else {
        /* Already accessed - return cached value */
        result = token_cache[token_idx];
    }

    pthread_mutex_unlock(&token_mutex);
    in_getenv = 0;

    return result;
}

/**
 * Intercepted secure_getenv function
 *
 * This function preserves secure_getenv semantics (returns NULL in privileged contexts)
 * while applying the same cached token protection as getenv.
 *
 * For sensitive tokens:
 * - First call: caches the value, unsets from environment, returns cached value
 * - Subsequent calls: returns the cached value from memory
 *
 * For all other variables: passes through to real secure_getenv (or getenv if unavailable)
 */
__attribute__((visibility("default")))
char *secure_getenv(const char *name) {
    ensure_real_secure_getenv();
    ensure_real_getenv();
    if (real_secure_getenv == NULL) {
        return getenv(name);
    }

    int token_idx = get_token_index(name);

    /* Not a sensitive token - pass through to real secure_getenv */
    if (token_idx < 0) {
        return real_secure_getenv(name);
    }

    /* Sensitive token - handle cached access with secure_getenv semantics */
    pthread_mutex_lock(&token_mutex);

    char *result = NULL;

    if (!token_accessed[token_idx]) {
        /* First access - get the real value using secure_getenv */
        result = real_secure_getenv(name);

        if (result != NULL) {
            /* Cache the value so subsequent reads succeed after unsetenv */
            /* Note: This memory is intentionally never freed - it must persist
             * for the lifetime of the process */
            token_cache[token_idx] = strdup(result);

            /* Unset the variable from the environment so /proc/self/environ is cleared */
            unsetenv(name);

            if (debug_enabled) {
                fprintf(stderr, "[one-shot-token] Token %s accessed and cached (length: %zu) (via secure_getenv)\n",
                        name, strlen(token_cache[token_idx]));
            }

            result = token_cache[token_idx];
        }

        /* Mark as accessed even if NULL (prevents repeated log messages) */
        token_accessed[token_idx] = 1;
    } else {
        /* Already accessed - return cached value */
        result = token_cache[token_idx];
    }

    pthread_mutex_unlock(&token_mutex);

    return result;
}
