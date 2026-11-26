import React from 'react';
import {AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence, registerRoot, staticFile, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {durationFrames, mappedCaptions, timeline, type Edit} from './model';
export type VideoProps = {edit:Edit};
function Graphic({text,style,accent,duration}:{text:string;style:'lower-third'|'callout'|'chapter';accent:string;duration:number}) {
  const frame=useCurrentFrame();const {width,height}=useVideoConfig();
  const enter=interpolate(frame,[0,8],[0,1],{extrapolateRight:'clamp'});
  const exit=interpolate(frame,[Math.max(0,duration-8),duration],[1,0],{extrapolateLeft:'clamp'});
  return <AbsoluteFill style={{justifyContent:'flex-end',alignItems:'flex-start',padding:width*.04,paddingBottom:height*.23,pointerEvents:'none'}}>
    <div style={{opacity:Math.min(enter,exit),transform:`translateY(${(1-enter)*16}px)`,maxWidth:'92%',
      borderLeft:`${Math.max(3,width*0.005)}px solid ${accent}`,background:'#10141ef2',color:'white',padding:'0.4em 0.6em',
      fontSize:width*(style==='chapter'?0.033:0.03),fontWeight:700,lineHeight:1.15,boxShadow:'0 8px 24px #0005',overflowWrap:'anywhere'}}>
      {style==='chapter'&&<div style={{fontSize:'0.3em',letterSpacing:'0.16em',color:accent,marginBottom:'0.6em'}}>IN THIS PART</div>}
      {text}
    </div>
  </AbsoluteFill>;
}
function Shot({scene,accent}:{scene:ReturnType<typeof timeline>[number];accent:string}) {
  const frame=useCurrentFrame();
  const {width,fps}=useVideoConfig();
  const mediaStyle:React.CSSProperties={width:'100%',height:'100%',objectFit:'cover',transform:`scale(${scene.zoom})`};
  return <AbsoluteFill style={{overflow:'hidden',background:'#101114'}}>
    <OffthreadVideo src={staticFile(`shot-${scene.id}.mp4`)} muted style={mediaStyle}/>
    {scene.broll && (scene.broll.kind==='image'
      ? <Img src={staticFile(scene.broll.path)} style={{...mediaStyle,transform:`scale(${1+0.025*frame/scene.duration})`,objectFit:scene.broll.fit}}/>
      : <OffthreadVideo src={staticFile(scene.broll.path)} muted style={{...mediaStyle,transform:undefined,objectFit:scene.broll.fit}}/>)}
    {(scene.graphics??[]).map(g=>{
      const from=Math.max(0,Math.round(g.in*fps)-scene.sourceStart);
      const duration=Math.min(scene.duration-from,Math.round(g.out*fps)-Math.round(g.in*fps));
      return <Sequence key={g.id} from={from} durationInFrames={duration}><Graphic text={g.text} style={g.style} accent={accent} duration={duration}/></Sequence>;
    })}
    {scene.title && <AbsoluteFill style={{justifyContent:scene.titleStyle==='card'?'center':'flex-end',padding:'6%',paddingBottom:'21%',background:scene.titleStyle==='card'?'rgba(10,12,18,0.78)':undefined}}>
      <div style={{alignSelf:'flex-start',maxWidth:'95%',borderLeft:`${width*0.006}px solid ${accent}`,padding:'0.3em 0.55em',background:'#111827e8',color:'white',fontSize:width*0.037,fontWeight:700,lineHeight:1.2,overflowWrap:'anywhere'}}>{scene.title}</div>
    </AbsoluteFill>}
  </AbsoluteFill>;
}
export function Video({edit}:VideoProps) {
  const {width}=useVideoConfig();
  return <AbsoluteFill style={{background:'#101114',fontFamily:'Arial, sans-serif'}}>
    {timeline(edit).map(scene=><Sequence key={scene.id} from={scene.from} durationInFrames={scene.duration}>
      <Shot scene={scene} accent={edit.accent}/>
      <Audio src={staticFile(`audio-${scene.id}.wav`)} volume={edit.speechVolume}/>
    </Sequence>)}
    {mappedCaptions(edit).map((c,i)=><Sequence key={i} from={c.from} durationInFrames={c.duration}>
      <AbsoluteFill style={{justifyContent:'flex-end',alignItems:'center',padding:'0 8% 6%'}}>
        <div style={{color:'white',background:'#080a10ed',fontSize:width*0.028,fontWeight:600,lineHeight:1.3,textAlign:'center',padding:'0.3em 0.6em',borderRadius:8,maxWidth:'100%',overflowWrap:'anywhere'}}>{c.text}</div>
      </AbsoluteFill>
    </Sequence>)}
    {edit.music && <Audio src={staticFile(edit.music.path)} loop volume={edit.music.volume}/>}
  </AbsoluteFill>;
}
const fallback:Edit={version:1,name:'Footage',source:'',fps:30,width:1920,height:1080,scenes:[{id:'scene-1',in:0,out:1,zoom:1,titleStyle:'lower-third'}],captions:[],speechVolume:1,accent:'#E84860'};
registerRoot(()=> <Composition id="Footage" component={Video} defaultProps={{edit:fallback}} width={1920} height={1080} fps={30} durationInFrames={30}
  calculateMetadata={({props})=>({width:props.edit.width,height:props.edit.height,fps:props.edit.fps,durationInFrames:durationFrames(props.edit)})}/>);
