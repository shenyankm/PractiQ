import { useEffect, useRef, useState } from "react";
import { api, type AudioLink, type Question } from "./api";
import { listeningAddress, listeningBlocks, playbackAddress } from "../../shared/listening";
import { ErrorNotice } from "./OperationFeedback";
import { message, MessageError, t, useI18n } from "./i18n";
import { ListeningPlayer } from "./ListeningPlayer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
export function EnglishFields({question:q,patch,images=[],onPendingChange,onDraftChange}:{question:Question;patch:(q:Partial<Question>)=>void;images?:{hash:string;label:string}[];onPendingChange:(pending:boolean)=>void;onDraftChange?:(dirty:boolean)=>void}) {
  useI18n();
  const mounted=useRef(false);
  const mode=useRef(q.answerMode);
  mode.current=q.answerMode;
  const [error,setError]=useState<unknown>(null);
  const [url,setUrl]=useState(()=>listeningAddress(q) || "");
  const [links,setLinks]=useState<AudioLink[]>([]);
  const generation=useRef(0);
  const [picking,setPicking]=useState(false);
  const urlDraft=q.answerMode==="listening" && url!=="" && url!==(listeningAddress(q) || "");
  useEffect(()=>{onDraftChange?.(urlDraft);},[urlDraft,onDraftChange]);
  useEffect(()=>{mounted.current=true;const epoch=generation;return ()=>{mounted.current=false;epoch.current++;};},[]);
  useEffect(()=>{generation.current++;if(q.answerMode!=="listening")setUrl("");},[q.answerMode]);
  function changeUrl(value:string) {
    setUrl(value);
    onDraftChange?.(mode.current==="listening" && value!=="" && value!==(listeningAddress(q) || ""));
  }
  function applyUrl() {
    const address=playbackAddress(url);
    if(!address){setError(new MessageError(message("请输入公开的 HTTP 或 HTTPS 播放地址。")));return;}
    generation.current++;setUrl(address);setLinks([]);setError(null);onDraftChange?.(false);
    patch({audioRef:null,contentBlocks:listeningBlocks(q.contentBlocks,address),audioStartSeconds:0,audioEndSeconds:null,missingFields:q.missingFields.filter(f=>f!=="media")});
  }
  async function pick(kind:"qr"|"url", hash?:string) {
    if(picking)return;
    setPicking(true);onPendingChange(true);setError(null);setLinks([]);
    const version=generation.current;
    try {
      if(kind==="url"){
        const result=await api({type:"listening_links",url:url.trim()});
        if(mounted.current && mode.current==="listening" && version===generation.current){setLinks(result);if(result.length===1)changeUrl(result[0].url);}
      } else {
        const result=await api(hash ? {type:"decode_audio_qr",hash} : {type:"pick_audio_qr"});
        if(result && mounted.current && mode.current==="listening" && version===generation.current){
          setLinks(result);if(result.length===1)changeUrl(result[0].url);
        }
      }
    }
    catch(e) {if(mounted.current && version===generation.current)setError(e);}
    finally {if(mounted.current){setPicking(false);onPendingChange(false);}}
  }
  return <section className="space-y-4">
    <label className="grid gap-2">{t("作答说明")}<Textarea value={q.instructions || ""} onChange={e=>patch({instructions:e.target.value || null})}/></label>
    {q.answerMode === "listening" && <div className="space-y-3 rounded border p-3">
      {(q.audioRef || listeningAddress(q)) && <Button variant="ghost" disabled={picking} onClick={()=>{generation.current++;setUrl("");onDraftChange?.(false);patch({audioRef:null,contentBlocks:listeningBlocks(q.contentBlocks,null)});}}>{t("移除音频")}</Button>}
      <label className="grid gap-2">{t("听力资源网址")}<Input type="url" maxLength={8192} disabled={picking} value={url} onChange={e=>{changeUrl(e.target.value);setLinks([]);setError(null);}}/></label>
      {urlDraft && !picking && <p role="status" className="text-xs text-muted-foreground">{t("网址尚未应用，请先应用播放地址或清空网址后保存。")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={picking || !url.trim()} onClick={applyUrl}>{t("应用播放地址")}</Button>
        <Button variant="outline" disabled={picking || !url.trim()} onClick={()=>void pick("url")}>{t("查找网页中的播放地址")}</Button>
        <Button variant="outline" disabled={picking} onClick={()=>void pick("qr")}>{t("识别二维码图片")}</Button>
      </div>
      {images.length>0 && <details><summary>{t("识别题目图片中的二维码")}</summary><div className="flex flex-wrap gap-2">{images.map((image,i)=><Button key={image.hash} variant="outline" disabled={picking} onClick={()=>void pick("qr",image.hash)}>{t("识别图片 {0}",{0:i+1})}{image.label ? " · "+image.label : ""}</Button>)}</div></details>}
      <p className="text-xs text-muted-foreground">{t("仅保存播放地址；二维码识别和应用地址不会联网。查找网页或播放时才联网，不保存音频文件。")}</p>
      {picking && <p role="status">{t("正在处理听力资源…")}</p>}
      {links.length>0 && <div className="space-y-2"><p>{t("请选择播放地址，再点击应用。")}</p>{links.map(link=><Button key={link.url} variant="outline" disabled={picking} className="h-auto w-full justify-start whitespace-normal break-all text-left" onClick={()=>{changeUrl(link.url);setLinks([]);}}>{link.label ? link.label+" · " : ""}{link.url}</Button>)}</div>}
      {error != null && <div role="alert"><ErrorNotice error={error} /></div>}
      <p className="text-xs text-muted-foreground">{t("支持 MP3、M4A/AAC、WAV，单次播放最多加载 25 MiB；历史音频仍可离线播放。")}</p>
      <ListeningPlayer key={listeningAddress(q) || q.audioRef?.sha256 || "missing"} question={q}/>
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
        <Button variant="outline" onClick={()=>patch({contentBlocks:[...q.contentBlocks,{partType:"text",role:q.questionKind === "translation"?"source_text":"material",textValue:""}]})}>{t("添加材料段落")}</Button>
        {q.questionKind === "writing" && <Button variant="outline" onClick={()=>patch({contentBlocks:[...q.contentBlocks,{partType:"text",role:"starter_text",label:t("续写开头"),textValue:""}]})}>{t("添加续写开头")}</Button>}
      </div>
    </>}
  </section>;
}
