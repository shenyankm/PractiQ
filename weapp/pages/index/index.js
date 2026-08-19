const app = getApp();

Page({
  data: { user: null },

  onShow() {
    if (!app.tokens()) {
      wx.reLaunch({ url: "/pages/login/index" });
      return;
    }
    this.setData({ user: wx.getStorageSync("user") || null });
  },

  logout() {
    const tokens = app.tokens();
    wx.request({
      url: `${app.globalData.apiBaseUrl}/api/v1/auth/logout`,
      method: "POST",
      header: { Authorization: `Bearer ${tokens?.accessToken || ""}` },
      complete: () => {
        app.clearSession();
        wx.reLaunch({ url: "/pages/login/index" });
      },
    });
  },
});
