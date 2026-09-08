import { Button } from "@taroify/core";
import { Input, View } from "@tarojs/components";
import { useState } from "react";
import { api } from "../../../api";
import type { QuestionRecord } from "../../../api/modules";
import { errorMessage } from "../../../api/message";
import { EntityCard, ErrorNotice, Page, PageHeader, StateView } from "../../../components/ui";
import { openPage } from "../../../navigation";

export default function SearchPage(): JSX.Element {
  const [query, setQuery] = useState(""); const [items, setItems] = useState<QuestionRecord[] | null>(null); const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false); const search = async () => { setLoading(true); setMessage(""); try { setItems((await api.search.questions({ q: query.trim(), limit: 100 })).items); } catch (error) { setMessage(errorMessage(error)); } finally { setLoading(false); } };
  return <Page><PageHeader eyebrow="统一搜索" title="找到需要的题目" subtitle="搜索自己可访问的题库内容。" /><View className="form-card app-stack"><Input className="form-input" confirmType="search" placeholder="输入题干关键词" value={query} onInput={(event) => setQuery(event.detail.value)} onConfirm={() => void search()} /><Button color="primary" shape="round" loading={loading} onClick={() => void search()}>搜索</Button>{message ? <ErrorNotice>{message}</ErrorNotice> : null}</View>{items ? <View className="list-stack">{items.length ? items.map((item) => <EntityCard key={item.id} title={item.stem} meta={`${item.question_type_id} · ${item.status}`} onClick={() => void openPage("/packages/content/questions/detail/index", { id: item.id })} />) : <StateView phase="empty" title="没有匹配的题目" detail="换一个关键词再试试。" />}</View> : null}</Page>;
}
