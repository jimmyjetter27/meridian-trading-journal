export const permissionSteps = [
  'Open your MetaTrader 5 Terminal application.',
  'Navigate to the top menu bar and select Tools ➔ Options ➔ Expert Advisors.',
  "Ensure the 'Allow algorithmic trading' checkbox is actively selected.",
  "Verify that 'Allow WebRequest for listed URL' is checked and that your local loopback address (http://localhost:port) is added to the authorized list.",
  'Confirm that the active MT5 chart has live execution enabled by verifying the Algo Trading icon on the terminal toolbar is green.',
];
export const diagnosticDictionary = {
  10014: {
    title: 'Invalid volume',
    steps: ['Check the broker’s minimum, maximum, and volume step for the exact symbol.'],
  },
  10017: {
    title: 'Trading disabled',
    steps: [
      'Check broker permissions, market session, and whether the account uses an investor password.',
      ...permissionSteps,
    ],
  },
  10026: {
    title: 'Server disabled automated trading',
    steps: [
      'Contact your broker or use an account authorized for automated execution. Local settings cannot override a server restriction.',
    ],
  },
  10027: { title: 'Terminal disabled automated trading', steps: permissionSteps },
  ERR_TRADE_SEND_FAILED: {
    title: 'Order transmission failed',
    steps: [
      'Check the terminal journal, connection, account permissions, and broker response before submitting again.',
    ],
  },
  BRIDGE_TIMEOUT: {
    title: 'Execution outcome unknown',
    steps: [
      'Inspect the MT5 orders, positions, and history before taking further action. This request will not be retried automatically.',
    ],
  },
};
export function diagnose(error) {
  const raw = String(error?.code || error?.message || error);
  const key = Object.keys(diagnosticDictionary).find((k) => raw.includes(k));
  return {
    ...(diagnosticDictionary[key] || {
      title: 'Bridge request failed',
      steps: ['Check the local bridge and terminal logs.'],
    }),
    code: key || 'BRIDGE_ERROR',
    message: String(error?.message || error),
    note: 'The WebRequest allowlist applies only to bridges whose Expert Advisor uses WebRequest. Replace localhost:port with your bridge’s actual configured address.',
  };
}
