import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, type PlaybackState, type Question, type Session } from "./api";
import { t, useI18n } from "./i18n";
import { Markdown } from "./Content";
import { Button } from "@/components/ui/button";

export function ListeningPlayer({question:q,session}:{question:Question;session?:Session}) {
  useI18n();
  const audio=useRef<HTMLAudioElement>(null);
  const [src,setSrc]=useState<string|null>(null);
  const [error,setError]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [busy,setBusy]=useState(false);
  const [state,setState]=useState<PlaybackState|null>(null);
  const chain=useRef(Promise.resolve());
  const started=useRef(false);
  const positionChosen=useRef(false);
  const ended=useRef(false);
  const start=q.audioStartSeconds ?? 0;
  const end=q.audioEndSeconds;
  const sid=session?.id;
  const live=!!session && session.finishedAt == null && session.submittedAt == null;
  const restricted=live && session.kind !== "practice";
  const hash=q.audioRef?.sha256;
  const media=q.audioRef?.mediaType;
  const allowedPosition=useRef(start);
  const progressAt=useRef(0);
  useEffect(()=>{
    let active=true,url:string|null=null;
    if(hash) void api({type:"asset",hash}).then(bytes=>{
      if(active) {url=URL.createObjectURL(new Blob([bytes],{type:media}));setSrc(url);}
    }).catch(()=>{if(active)setError(true);});
    return ()=>{active=false;if(url)URL.revokeObjectURL(url);};
  },[hash,media]);
  useEffect(()=>{
    if(sid && q.id && live) void api({type:"listening_playback",id:sid,question_id:q.id,action:"state"}).then(setState).catch(()=>setError(true));
  },[sid,q.id,live]);
  function persist(action:"progress"|"pause"|"end",position:number) {
    if(!sid || !q.id || !live || !started.current) return;
    const question_id=q.id;
    chain.current=chain.current.then(async()=>{
      const next=await api({type:"listening_playback",id:sid,question_id,action,position});
      setState(next);
    }).catch(()=>{setError(true);audio.current?.pause();});
  }
  const saveOnExit=useEffectEvent((position:number)=>{if(!ended.current)persist("pause",position);});
  useEffect(()=>{
    const player=audio.current;
    const stop=()=>{if(player){player.pause();saveOnExit(player.currentTime);}};
    document.addEventListener("visibilitychange",stop);
    window.addEventListener("pagehide",stop);
    return ()=>{stop();document.removeEventListener("visibilitychange",stop);window.removeEventListener("pagehide",stop);};
  },[src]);
  useEffect(()=>{if(!live)audio.current?.pause();},[live]);
  async function toggle() {
    const player=audio.current;
    if(!player || busy) return;
    if(!player.paused){player.pause();return;}
    setBusy(true);setError(false);
    try {
      await chain.current;
      let current=state;
      if(sid && q.id && live) current=await api({type:"listening_playback",id:sid,question_id:q.id,action:"state"});
      if(restricted && current && !current.active && current.used>=current.limit) {setState(current);return;}
      const limit=end ?? player.duration;
      if(!Number.isFinite(player.duration) || start>=player.duration || limit>player.duration+0.05) throw new Error("Invalid audio segment");
      if(restricted || (!started.current && !positionChosen.current && current?.active)) player.currentTime=current?.active ? current.position : start;
      else if(player.currentTime<start || player.currentTime>=limit || ended.current) player.currentTime=start;
      allowedPosition.current=player.currentTime;ended.current=false;
      await player.play();
      if(sid && q.id && live) setState(await api({type:"listening_playback",id:sid,question_id:q.id,action:"start"}));
      started.current=true;
    } catch {player.pause();setError(true);} finally {setBusy(false);}
  }
  function finish() {
    if(ended.current)return;
    ended.current=true;
    const player=audio.current;
    if(player){persist("end",Math.min(player.currentTime,end ?? player.duration));player.pause();}
    started.current=false;
  }
  const exhausted=restricted && state && !state.active && state.used>=state.limit;
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={t("听力播放器")}>
    <p className="text-sm font-medium">{t("听力题")}</p>
    <Markdown>{q.stem}</Markdown><Markdown>{q.instructions}</Markdown>
    {!hash && <p role="note">{t("听力音频缺失，请在题目编辑中补充。")}</p>}
    {hash && <>
      <audio ref={audio} src={src || undefined} preload="metadata"
        onLoadedMetadata={()=>{if(audio.current)audio.current.currentTime=start;}}
        onPlay={()=>setPlaying(true)} onPause={()=>{setPlaying(false);if(audio.current && !ended.current)persist("pause",audio.current.currentTime);}}
        onEnded={finish} onError={()=>setError(true)}
        onRateChange={()=>{if(restricted && audio.current)audio.current.playbackRate=1;}}
        onSeeking={()=>{const p=audio.current;if(p && restricted && Math.abs(p.currentTime-allowedPosition.current)>0.25)p.currentTime=allowedPosition.current;}}
        onTimeUpdate={()=>{
          const p=audio.current;if(!p)return;
          allowedPosition.current=p.currentTime;
          if(end != null && p.currentTime>=end){finish();return;}
          if(Date.now()-progressAt.current>1000){progressAt.current=Date.now();persist("progress",p.currentTime);}
        }}/>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!src || busy || !!exhausted || (restricted && !state)} onClick={()=>void toggle()}>{playing?t("暂停播放"):t("播放听力")}</Button>
        {!restricted && <>
          <Button variant="outline" disabled={!src} onClick={()=>{if(audio.current){positionChosen.current=true;audio.current.currentTime=start;ended.current=false;}}}>{t("从头重听")}</Button>
          <label className="text-sm">{t("播放速度")} <select aria-label={t("播放速度")} defaultValue="1" onChange={e=>{if(audio.current)audio.current.playbackRate=Number(e.target.value);}}>{[0.75,1,1.25,1.5].map(v=><option key={v} value={v}>{v}×</option>)}</select></label>
          <AudioSeek player={audio.current} start={start} end={end} onSeek={()=>{positionChosen.current=true;}}/>
        </>}
        {restricted && state && <span className="text-sm">{t("已播放 {0} / {1} 遍",{0:state.used,1:state.limit})}</span>}
      </div>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{t("音频加载或播放失败，请检查文件后重试。")}</p>}
  </section>;
}
function AudioSeek({player,start,end,onSeek}:{player:HTMLAudioElement|null;start:number;end?:number|null;onSeek:()=>void}) {
  const [position,setPosition]=useState(start);
  const [duration,setDuration]=useState(start);
  useEffect(()=>{
    if(!player)return;
    const sync=()=>{setPosition(player.currentTime);setDuration(player.duration);};
    player.addEventListener("timeupdate",sync);player.addEventListener("loadedmetadata",sync);sync();
    return ()=>{player.removeEventListener("timeupdate",sync);player.removeEventListener("loadedmetadata",sync);};
  },[player]);
  const max=Math.max(start,Math.min(end ?? Infinity,Number.isFinite(duration)?duration:start));
  return <input type="range" aria-label={t("听力播放进度")} min={start} max={max} step="0.1" value={Math.min(position,max)} onChange={e=>{if(player){onSeek();player.currentTime=Number(e.target.value);}}}/>;
}
