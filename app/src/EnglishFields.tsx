import { useEffect, useRef, useState } from "react";
import { api, type Question } from "./api";
import { t, useI18n } from "./i18n";
import { ListeningPlayer } from "./ListeningPlayer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
export function EnglishFields({question:q,patch}:{question:Question;patch:(q:Partial<Question>)=>void}) {
  useI18n();
  const staged=useRef(new Set<string>());
  const mounted=useRef(false);
  const [error,setError]=useState(false);
  const [picking,setPicking]=useState(false);
  useEffect(()=>{mounted.current=true;const hashes=staged.current;return ()=>{mounted.current=false;for(const hash of hashes)void api({type:"release_audio",hash}).catch(()=>{});hashes.clear();};},[]);
  function release(hash?:string) {
    if(hash && staged.current.delete(hash))void api({type:"release_audio",hash}).catch(()=>{});
  }
  async function pick() {
    setPicking(true);setError(false);
    try {const result=await api({type:"pick_audio"});if(result){
      const hash=result.reference.sha256;
      if(!mounted.current){void api({type:"release_audio",hash}).catch(()=>{});return;}
      if(q.audioRef?.sha256!==hash)release(q.audioRef?.sha256);
      staged.current.add(hash);
      patch({audioRef:result.reference,audioStartSeconds:0,audioEndSeconds:null,missingFields:q.missingFields.filter(f=>f!=="media")});
    }}
    catch {if(mounted.current)setError(true);} finally {if(mounted.current)setPicking(false);}
  }
  return <section className="space-y-4">
    <label className="grid gap-2">{t("作答说明")}<Textarea value={q.instructions || ""} onChange={e=>patch({instructions:e.target.value || null})}/></label>
    {q.answerMode === "listening" && <div className="space-y-3 rounded border p-3">
      <Button variant="outline" disabled={picking} onClick={()=>void pick()}>{t("选择听力音频")}</Button>
      {q.audioRef && <Button variant="ghost" onClick={()=>{release(q.audioRef?.sha256);patch({audioRef:null});}}>{t("移除音频")}</Button>}
      {error && <p role="alert">{t("音频加载或播放失败，请检查文件后重试。")}</p>}
      <p className="text-xs text-muted-foreground">{t("支持 MP3、M4A/AAC、WAV，每个文件不超过 25 MiB。")}</p>
      <ListeningPlayer key={q.audioRef?.sha256 || "missing"} question={q}/>
      <div className="grid grid-cols-3 gap-3">
        <label>{t("开始秒数")}<Input type="number" min={0} step="0.1" value={q.audioStartSeconds ?? 0} onChange={e=>patch({audioStartSeconds:Number(e.target.value)})}/></label>
        <label>{t("结束秒数（可留空）")}<Input type="number" min={0} step="0.1" value={q.audioEndSeconds ?? ""} onChange={e=>patch({audioEndSeconds:e.target.value?Number(e.target.value):null})}/></label>
        <label>{t("考试播放次数")}<Input type="number" min={1} max={100} value={q.examPlayCount ?? 2} onChange={e=>patch({examPlayCount:Number(e.target.value)})}/></label>
      </div>
      <label className="grid gap-2">{t("听力原文")}<Textarea rows={6} value={(q.transcript || []).map(b=>b.textValue || b.markdownValue || "").join("\n\n")} onChange={e=>patch({transcript:e.target.value?[{partType:"text",textValue:e.target.value}]:[]})}/></label>
      <p className="text-xs text-muted-foreground">{t("听力原文仅在整组答后或交卷后显示。")}</p>
    </div>}
    {(q.questionKind === "translation" || q.questionKind === "writing") && <>
      <div className="grid grid-cols-2 gap-3">
        {q.questionKind === "translation" && <label>{t("源语言代码")}<Input placeholder={t("例如 en 或 zh-CN")} value={q.sourceLanguage || ""} onChange={e=>patch({sourceLanguage:e.target.value || null})}/></label>}
        <label>{t("目标语言代码")}<Input placeholder={t("例如 en 或 zh-CN")} value={q.targetLanguage || ""} onChange={e=>patch({targetLanguage:e.target.value || null})}/></label>
      </div>
      {q.questionKind === "writing" && <div className="grid grid-cols-3 gap-3">
        <label>{t("写作文体")}<Input value={q.writingGenre || ""} onChange={e=>patch({writingGenre:e.target.value || null})}/></label>
        <label>{t("最少词数")}<Input type="number" min={0} value={q.minWords ?? ""} onChange={e=>patch({minWords:e.target.value?Number(e.target.value):null})}/></label>
        <label>{t("最多词数")}<Input type="number" min={1} value={q.maxWords ?? ""} onChange={e=>patch({maxWords:e.target.value?Number(e.target.value):null})}/></label>
      </div>}
      <div className="space-y-3 rounded border p-3">
        <p>{t("题目材料")}</p>
        {q.contentBlocks.map((b,i)=><div className="space-y-2" key={i}>
          <Input aria-label={t("材料段落标签")} value={b.label || ""} onChange={e=>patch({contentBlocks:q.contentBlocks.map((v,j)=>j===i?{...v,label:e.target.value || null}:v)})}/>
          <Textarea aria-label={t("材料内容")} rows={5} value={b.textValue || b.markdownValue || ""} onChange={e=>patch({contentBlocks:q.contentBlocks.map((v,j)=>j===i?{...v,textValue:e.target.value,markdownValue:null}:v)})}/>
          <Button variant="ghost" onClick={()=>patch({contentBlocks:q.contentBlocks.filter((_,j)=>j!==i)})}>{t("删除")}</Button>
        </div>)}
        <Button variant="outline" onClick={()=>patch({contentBlocks:[...q.contentBlocks,{partType:"text",role:q.questionKind === "translation"?"source_text":"material",textValue:""}]})}>{t("增加材料段落")}</Button>
        {q.questionKind === "writing" && <Button variant="outline" onClick={()=>patch({contentBlocks:[...q.contentBlocks,{partType:"text",role:"starter_text",label:t("续写开头"),textValue:""}]})}>{t("增加续写开头")}</Button>}
      </div>
    </>}
  </section>;
}
