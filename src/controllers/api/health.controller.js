export function createController(context) {
  const { auth, gstProvider, sandboxGst, gstStatus, readiness } = context;
  return {
    ready: async (_req, res) => {
      const state = await readiness.check();
      if (!state.ready) res.setHeader('Retry-After', '5');
      res.status(state.ready ? 200 : 503).json(state);
    },
    status: async (req, res) =>
      res.json(
        auth && !(await auth.getSessionUser(req))
          ? {
              ok: true,
            }
          : {
              ok: true,
              gstConfigured: gstStatus().configured,
              gstMode: gstProvider === 'portal' ? 'portal' : 'provider',
              gstProvider,
              ...(gstProvider === 'sandbox'
                ? {
                    gstEnvironment: sandboxGst.status().mode,
                  }
                : {}),
            },
      ),
  };
}
