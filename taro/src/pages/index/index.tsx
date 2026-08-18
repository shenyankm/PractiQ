import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";

import "./index.css";

export default function IndexPage() {
  return (
    <View className="page">
      <Text className="eyebrow">PractiQ · {Taro.getEnv()}</Text>
      <Text className="title">Taro 多端迁移基线已就绪</Text>
      <Text className="body">高频题库与练习流程将按迁移计划逐步接入。</Text>
    </View>
  );
}
