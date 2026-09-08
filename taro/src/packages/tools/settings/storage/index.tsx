import { protectedPage } from "../../../../auth/protected-page";
import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { sessionStore } from "../../../../auth/session";
import { clearUserCache } from "../../../../cache";
import {
  Page,
  PageHeader,
  Section,
  confirmDanger,
} from "../../../../components/ui";

function StoragePage(): JSX.Element {
  const clear = async () => {
    const user = sessionStore.getSnapshot()?.user;
    if (!user) return;
    if (
      await confirmDanger(
        "清理业务缓存",
        "将删除当前账号的学科、题型、本人题库和分析缓存，不会清除服务端数据。",
        "清理",
      )
    ) {
      await clearUserCache(user.id);
      await Taro.showToast({ title: "缓存已清理", icon: "success" });
    }
  };
  return (
    <Page>
      <PageHeader
        eyebrow="设置"
        title="缓存管理"
        subtitle="缓存严格按用户隔离，登录令牌、支付、AI 和管理员数据从不持久化。"
      />
      <Section title="缓存策略">
        <View className="form-card app-stack">
          <Text className="app-muted">
            业务内容不再写入本地缓存；每次打开或恢复页面都联网重新读取。离线不显示旧内容，退出或换号清除内存和旧版本缓存。
          </Text>
          <Button
            color="danger"
            variant="outlined"
            onClick={() => void clear()}
          >
            清理当前账号缓存
          </Button>
        </View>
      </Section>
    </Page>
  );
}

export default protectedPage(StoragePage);
