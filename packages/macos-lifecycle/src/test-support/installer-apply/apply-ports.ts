import type {
  InstallPorts,
  LockSession,
  Revalidation,
} from '../../installation-transaction/contracts.js';

/** B1 lane-owned ports wrappers. The shared installer fixture
 * (`test-support/installer/fixture.ts`) is read-only for this lane; every
 * scenario-specific provider behavior lives here.
 */

/** Defer the first authorizeLocalAdmin resolution so a test can mutate
 * shared inputs mid-flight (after apply starts, before auth resolves).
 * Later authorizations pass through to the wrapped ports.
 */
export function deferAuthorize(ports: InstallPorts): {
  ports: InstallPorts;
  release: (value: boolean) => void;
} {
  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let used = false;
  return {
    ports: {
      ...ports,
      authorizeLocalAdmin: async (): Promise<boolean> => {
        if (!used) {
          used = true;
          return gate;
        }
        return ports.authorizeLocalAdmin();
      },
    },
    release: (value: boolean) => {
      release(value);
    },
  };
}

/** Lock acquisition succeeds but release rejects: cleanup outcome unknown. */
export function failLockRelease(ports: InstallPorts): InstallPorts {
  return {
    ...ports,
    lock: async (): Promise<LockSession> => {
      const session = await ports.lock();
      if (!session.acquired) return session;
      return {
        acquired: true,
        release: async (): Promise<void> => {
          throw new Error('RELEASE_REJECTED');
        },
      };
    },
  };
}

/** authorizeLocalAdmin throws instead of answering (R8: outer exception). */
export function throwOnAuthorize(ports: InstallPorts): InstallPorts {
  return {
    ...ports,
    authorizeLocalAdmin: async (): Promise<boolean> => {
      throw new Error('AUTH_EXPLODED');
    },
  };
}

/** lock() throws instead of answering (R8: outer exception). */
export function throwOnLock(ports: InstallPorts): InstallPorts {
  return {
    ...ports,
    lock: async (): Promise<LockSession> => {
      throw new Error('LOCK_EXPLODED');
    },
  };
}

/** revalidate() throws instead of answering (R8: outer exception). */
export function throwOnRevalidate(ports: InstallPorts): InstallPorts {
  return {
    ...ports,
    revalidate: async (): Promise<Revalidation> => {
      throw new Error('REVALIDATE_EXPLODED');
    },
  };
}
