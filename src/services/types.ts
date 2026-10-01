export interface Clock {
  now: () => Date;
}

export interface Env {
  now: () => Date;
  rand: () => number;
}

export const defaultEnv: Env = {
  now: () => new Date(),
  rand: Math.random
};
