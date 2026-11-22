import { useRef, useState } from 'react'
import './App.css'

const ways = [
  ['◎', '零基础入门', '从拼音和发音开始'],
  ['↗', '逐课进阶', '完成一课，再进入下一课'],
  ['♫', '听音跟读', '每课练习标准发音'],
]
const stages = [
  ['01', '拼音', '从发音和拼读开始', '当前阶段'],
  ['02', '日常汉语', '练习生活中的交流', '规划中'],
  ['03', 'HSK', '分级提升综合语言能力', '规划中'],
]

export default function App() {
  const audio = useRef<HTMLAudioElement>(null)
  const [error, setError] = useState(false)
  async function play() {
    if (!audio.current) return
    setError(false)
    audio.current.currentTime = 0
    try { await audio.current.play() } catch { setError(true) }
  }
  return <>
    <header className="topbar"><div className="wrap header-row">
      <a className="brand" href="#top" aria-label="汉语起步，返回首页"><span className="brand-icon" aria-hidden="true">◡</span>汉语起步</a>
      <nav aria-label="主导航"><a href="#top" aria-current="page">首页</a><a href="#method">学习方式</a><a href="#path">学习路径</a></nav>
      <span className="build-label">新平台 · P0 工程版</span>
    </div></header>
    <main id="top">
      <section className="hero wrap" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">零基础汉语课程</p>
          <h1 id="hero-title">从拼音开始，<br />系统学会汉语</h1>
          <p>听标准发音、看口型提示、跟读练习。按照自己的节奏，一课一课地学。</p>
          <div className="actions"><a className="primary" href="#preview">先听一听 a <span aria-hidden="true">→</span></a><a className="secondary" href="#path">查看学习路径 ↗</a></div>
          <small>正式课程正在从原型迁移；现有原型保留在项目根目录。</small>
        </div>
        <img className="hero-art" src="/media/hero-student.webp" width="1498" height="750" alt="大学生在窗边用电脑学习汉语，桌上有书和熊猫玩偶" />
      </section>
      <section className="section wrap" id="method" aria-labelledby="method-title">
        <div className="section-title"><div><span>HOW WE LEARN</span><h2 id="method-title">学习方式</h2></div><p>听、看、练习，逐步掌握。</p></div>
        <div className="ways">{ways.map(([icon,title,description]) => <article className="way" key={title}><span className="way-icon" aria-hidden="true">{icon}</span><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
      </section>
      <section className="section wrap" id="path" aria-labelledby="path-title">
        <div className="section-title"><div><span>YOUR LEARNING PATH</span><h2 id="path-title">学习路径</h2></div><p>先打好发音基础，再进入生活表达。</p></div>
        <div className="stages">{stages.map(([number,title,description,state]) => <article className={number === '01' ? 'stage active' : 'stage'} key={number}><div className="stage-top"><b>{number}</b><small>{state}</small></div><h3>{title}</h3><p>{description}</p></article>)}</div>
      </section>
      <section className="section wrap preview" id="preview" aria-labelledby="preview-title">
        <div className="section-title"><div><span>SOUND PREVIEW</span><h2 id="preview-title">发音体验 · a</h2></div><p>张开嘴巴，听一听这个单韵母。</p></div>
        <div className="sound-card"><div className="letter" aria-hidden="true">a</div><div className="sound-copy"><h3>张大嘴巴，发出 a</h3><p>这是首页试听。完整课程将在第一课审计后迁入新平台。</p></div><button type="button" onClick={play} aria-label="播放汉语单韵母 a 的发音">▶ 听标准发音</button></div>
        {error && <p className="audio-error" role="alert">音频暂时无法播放，请稍后重试。</p>}
        <audio ref={audio} src="/media/pinyin-a.mp3" preload="none" onError={() => setError(true)} />
      </section>
    </main>
    <footer><div className="wrap footer-row"><strong>汉语起步</strong><span>从拼音开始，一课一课地学。</span></div></footer>
  </>
}
