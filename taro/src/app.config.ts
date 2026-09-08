export default defineAppConfig({
  pages: ["pages/login/index", "pages/privacy/index", "pages/home/index", "pages/banks/index", "pages/profile/index"],
  subpackages: [
    { root: "packages/content", pages: ["banks/detail/index", "banks/edit/index", "questions/detail/index", "questions/edit/index"] },
    { root: "packages/practice", pages: ["setup/index", "session/index", "results/index"] },
    { root: "packages/tools", pages: ["imports/index", "imports/create/index", "imports/detail/index", "analytics/index", "analytics/bank/index", "search/index", "settings/storage/index"] },
    { root: "packages/admin", pages: ["users/index", "payments/index", "knowledge-points/index"] },
    { root: "packages/groups", pages: ["index", "detail/index", "join/index"] },
  ],
  window: {
    navigationBarBackgroundColor: "#0B5F4B",
    navigationBarTextStyle: "white",
    backgroundColor: "#F4F7F6",
    backgroundTextStyle: "dark",
  },
  tabBar: {
    custom: false,
    color: "#65736F",
    selectedColor: "#0B5F4B",
    backgroundColor: "#FFFFFF",
    borderStyle: "white",
    list: [
      {
        pagePath: "pages/home/index",
        text: "学习",
      },
      {
        pagePath: "pages/banks/index",
        text: "题库",
      },
      {
        pagePath: "pages/profile/index",
        text: "我的",
      },
    ],
  },
});
