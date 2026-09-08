import { Button } from "@taroify/core";
import { Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useState } from "react";
import { apiClient } from "../../api";
import { errorMessage } from "../../api/message";
import { sessionStore } from "../../auth/session";
import { taroLoginProvider } from "../../auth/taro-login";
import { loginWithWeChat } from "../../auth/wechat";
import { BrandMark, ErrorNotice } from "../../components/ui";
import "./index.css";

export default function LoginPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  useDidShow(() => { if (sessionStore.getSnapshot()) void Taro.switchTab({ url: "/pages/home/index" }); });
  const login = async (): Promise<void> => {
    if (loading) return;
    setLoading(true); setMessage("");
    try { await loginWithWeChat(apiClient, taroLoginProvider); await Taro.switchTab({ url: "/pages/home/index" }); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setLoading(false); }
  };
  return <View className="login-page">
    <View className="login-hero"><BrandMark /><Text className="eyebrow">PRACTIQ</Text><Text className="login-title">把每一次练习，变成看得见的进步</Text><Text className="login-copy">轻量整理题库，专注完成练习，用数据找到下一步。</Text></View>
    <View className="login-card app-surface"><Text className="login-card-title">开始学习</Text><Text className="login-card-detail">点击后才会向微信申请临时登录凭证，登录令牌仅保存在本次运行内存中。</Text>{message ? <ErrorNotice>登录失败：{message}</ErrorNotice> : null}<Button className="login-button" color="primary" shape="round" block loading={loading} disabled={loading} onClick={() => void login()}>微信登录</Button><Text className="login-footnote" onClick={() => void Taro.navigateTo({ url: "/pages/privacy/index" })}>继续即表示你已阅读并同意《隐私政策》</Text></View>
  </View>;
}
