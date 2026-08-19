const app = getApp();

Page({
  data: { loading: false, error: "" },

  onShow() {
    if (app.tokens()) wx.reLaunch({ url: "/pages/index/index" });
  },

  login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    wx.login({
      success: ({ code }) =>
        wx.request({
          url: `${app.globalData.apiBaseUrl}/api/v1/auth/wechat-login`,
          method: "POST",
          data: { code },
          success: ({ statusCode, data }) => {
            if (statusCode !== 200 || !data.data) {
              this.setData({ error: data.error?.message || "微信登录失败" });
              return;
            }
            wx.setStorageSync("tokens", data.data.tokens);
            wx.setStorageSync("user", data.data.user);
            wx.reLaunch({ url: "/pages/index/index" });
          },
          fail: () => this.setData({ error: "无法连接服务器" }),
          complete: () => this.setData({ loading: false }),
        }),
      fail: () =>
        this.setData({ loading: false, error: "无法获取微信登录凭证" }),
    });
  },
});
