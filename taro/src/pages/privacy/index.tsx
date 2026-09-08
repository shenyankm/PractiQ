import { Text, View } from "@tarojs/components";
import { Page, PageHeader, Section } from "../../components/ui";

export default function PrivacyPage(): JSX.Element {
  return <Page><PageHeader eyebrow="PRACTIQ" title="隐私政策" subtitle="最后更新：2026 年 8 月 27 日" /><Section title="我们处理的信息"><View className="form-card"><Text className="app-muted">登录时使用微信提供的临时凭证识别账号；你主动提交的题库、题目、练习记录和上传文件用于提供学习服务。</Text></View></Section><Section title="存储与安全"><View className="form-card"><Text className="app-muted">登录令牌只保存在运行内存中。上传内容和业务数据通过加密连接传输；私有 AI 服务不公开访问，也不会接收用户、题库或任务资源 ID。</Text></View></Section><Section title="你的选择"><View className="form-card"><Text className="app-muted">你可以退出登录、清理本地业务缓存，或删除自己创建且允许删除的内容。删除及封禁等危险操作均需要再次确认。</Text></View></Section></Page>;
}
