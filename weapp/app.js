App({
  globalData: {
    // ponytail: local default; set apiBaseUrl in storage for device/production builds.
    apiBaseUrl: wx.getStorageSync("apiBaseUrl") || "http://127.0.0.1:8080",
  },

  tokens() {
    return wx.getStorageSync("tokens") || null;
  },

  clearSession() {
    wx.removeStorageSync("tokens");
    wx.removeStorageSync("user");
  },
});
