let _balance = $state<number | null>(null);

export const balance = {
  get value() {
    return _balance;
  },

  set(val: number) {
    _balance = val;
  },

  reset() {
    _balance = null;
  },
};
