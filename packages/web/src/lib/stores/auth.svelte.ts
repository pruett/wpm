const TOKEN_KEY = "wpm_token";
const ADDRESS_KEY = "wpm_address";

let _token = $state<string | null>(null);
let _address = $state<string | null>(null);

function safeStorage() {
  try {
    if (typeof window === "undefined") return null;
    // Test that localStorage actually works (jsdom can have a non-functional stub)
    const test = "__wpm_test__";
    window.localStorage.setItem(test, "1");
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    return null;
  }
}

// Restore from localStorage on load
try {
  const s = safeStorage();
  if (s) {
    _token = s.getItem(TOKEN_KEY);
    _address = s.getItem(ADDRESS_KEY);
  }
} catch {
  // Ignore
}

export const auth = {
  get token() {
    return _token;
  },
  get address() {
    return _address;
  },
  get isLoggedIn() {
    return _token !== null;
  },

  login(token: string, address: string) {
    _token = token;
    _address = address;
    try {
      safeStorage()?.setItem(TOKEN_KEY, token);
      safeStorage()?.setItem(ADDRESS_KEY, address);
    } catch {
      /* noop */
    }
  },

  logout() {
    _token = null;
    _address = null;
    try {
      safeStorage()?.removeItem(TOKEN_KEY);
      safeStorage()?.removeItem(ADDRESS_KEY);
    } catch {
      /* noop */
    }
  },
};
