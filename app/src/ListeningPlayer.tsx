import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, type PlaybackState, type Question, type Session } from "./api";
import { t, useI18n } from "./i18n";
import { Markdown } from "./Content";
import { acquireAsset } from "./asset-urls";
import { materialLanguage } from "./english";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function ListeningPlayer({question:q,session}:{question:Question;session?:Session}) {
  useI18n();
  const section=useRef<HTMLElement>(null);
  const audio=useRef<HTMLAudioElement>(null);
  const [src,setSrc]=useState<string|null>(null);
  const [nearby,setNearby]=useState(typeof IntersectionObserver === "undefined");
  const [loading,setLoading]=useState(false);
  const [playRequested,setPlayRequested]=useState(false);
  const [loadAttempt,setLoadAttempt]=useState(0);
  const [error,setError]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [busy,setBusy]=useState(false);
  const [state,setState]=useState<PlaybackState|null>(null);
  const chain=useRef(Promise.resolve());
  const started=useRef(false);
  const deferredEnd=useRef<number|null>(null);
  const deferredPause=useRef<number|null>(null);
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
    if(nearby || !section.current)return;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){setNearby(true);observer.disconnect();}
    },{rootMargin:"200px"});
    observer.observe(section.current);
    return ()=>observer.disconnect();
  },[nearby]);
  useEffect(()=>{setPlayRequested(false);},[hash,media]);
  useEffect(()=>{
    let active=true;
    setSrc(null); setError(false); setLoading(!!hash && nearby);
    const resource=hash && nearby ? acquireAsset(hash,media) : undefined;
    if(resource) void resource.url.then(url=>{
      if(active) setSrc(url);
    }).catch(()=>{if(active){setError(true);setPlayRequested(false);}})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;resource?.release();};
  },[hash,media,nearby,loadAttempt]);
  const playWhenLoaded=useEffectEvent(()=>{
    if(playRequested){setPlayRequested(false);void toggle();}
  });
  useEffect(()=>{
    if(src && Number.isFinite(audio.current?.duration))playWhenLoaded();
  },[src,playRequested]);
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
    const hide=()=>{setPlayRequested(false);stop();};
    document.addEventListener("visibilitychange",hide);
    window.addEventListener("pagehide",hide);
    return ()=>{stop();document.removeEventListener("visibilitychange",hide);window.removeEventListener("pagehide",hide);};
  },[src]);
  useEffect(()=>{if(!live){audio.current?.pause();setPlayRequested(false);}},[live]);
  async function toggle() {
    const player=audio.current;
    if(!player || busy) return;
    if(!src){setPlayRequested(true);setNearby(true);setLoadAttempt(value=>value+1);return;}
    if(!Number.isFinite(player.duration)){setPlayRequested(true);return;}
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
      allowedPosition.current=player.currentTime;ended.current=false;deferredEnd.current=null;
      started.current=false;deferredPause.current=null;
      await player.play();
      if(sid && q.id && live) setState(await api({type:"listening_playback",id:sid,question_id:q.id,action:"start"}));
      started.current=true;
      if(deferredEnd.current != null){persist("end",deferredEnd.current);deferredEnd.current=null;started.current=false;}
      else if(deferredPause.current != null){persist("pause",deferredPause.current);started.current=false;}
      deferredPause.current=null;
    } catch {player.pause();setError(true);} finally {setBusy(false);}
  }
  function finish() {
    if(ended.current)return;
    ended.current=true;
    const player=audio.current;
    if(player){
      const position=Math.min(player.currentTime,end ?? player.duration);
      if(started.current)persist("end",position);
      else deferredEnd.current=position;
      player.pause();
    }
    started.current=false;
  }
  const exhausted=restricted && state && !state.active && state.used>=state.limit;
  return <section ref={section} className="space-y-3 rounded-lg border bg-card p-4" aria-label={t("听力播放器")}>
    <p className="text-sm font-medium">{t("听力题")}</p>
    <Markdown>{q.stem}</Markdown><Markdown>{q.instructions}</Markdown>
    {!hash && <p role="note">{t("听力音频缺失，请在题目编辑中补充。")}</p>}
    {hash && <>
      <audio lang={materialLanguage(q)} ref={audio} src={src || undefined} preload="metadata"
        onLoadedMetadata={()=>{if(audio.current)audio.current.currentTime=start;if(playRequested){setPlayRequested(false);void toggle();}}}
        onPlay={()=>setPlaying(true)} onPause={()=>{
          setPlaying(false);
          const player=audio.current;
          // Natural EOF fires pause before ended; only ended completes that play.
          if(player && !ended.current && !player.ended){
            if(started.current){persist("pause",player.currentTime);started.current=false;}
            else deferredPause.current=player.currentTime;
          }
        }}
        onEnded={finish} onError={()=>{setError(true);setPlayRequested(false);}}
        onRateChange={()=>{if(restricted && audio.current)audio.current.playbackRate=1;}}
        onSeeking={()=>{const p=audio.current;if(p && restricted && Math.abs(p.currentTime-allowedPosition.current)>0.25)p.currentTime=allowedPosition.current;}}
        onTimeUpdate={()=>{
          const p=audio.current;if(!p)return;
          allowedPosition.current=p.currentTime;
          if(end != null && p.currentTime>=end){finish();return;}
          if(Date.now()-progressAt.current>1000){progressAt.current=Date.now();persist("progress",p.currentTime);}
        }}/>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" aria-busy={loading || playRequested || busy} disabled={loading || playRequested || busy || !!exhausted || (restricted && !state)} onClick={()=>void toggle()}>{loading || playRequested ? t("加载中…") : playing?t("暂停播放"):t("播放听力")}</Button>
        {!restricted && <>
          <Button variant="outline" disabled={!src} onClick={()=>{if(audio.current){positionChosen.current=true;audio.current.currentTime=start;ended.current=false;}}}>{t("从头重听")}</Button>
          <label className="grid gap-2 text-sm">{t("播放速度")} <NativeSelect aria-label={t("播放速度")} defaultValue="1" onChange={e=>{if(audio.current)audio.current.playbackRate=Number(e.target.value);}}>{[0.75,1,1.25,1.5].map(v=><NativeSelectOption key={v} value={v}>{v}×</NativeSelectOption>)}</NativeSelect></label>
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
  return <input className="audio-seek w-full accent-primary sm:w-48" type="range" aria-label={t("听力播放进度")} min={start} max={max} step="0.1" value={Math.min(position,max)} onChange={e=>{if(player){onSeek();player.currentTime=Number(e.target.value);}}}/>;
}
