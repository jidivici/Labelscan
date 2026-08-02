const NetInfo = {
  addEventListener: jest.fn(() => () => undefined),
  fetch: jest.fn(async () => ({
    isConnected: true,
    isInternetReachable: true,
  })),
};

export default NetInfo;
