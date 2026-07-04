import Nav from './components/Nav.jsx';
import Hero from './components/Hero.jsx';
import Ticker from './components/Ticker.jsx';
import Problem from './components/Problem.jsx';
import Features from './components/Features.jsx';
import SignalAnatomy from './components/SignalAnatomy.jsx';
import Toolkit from './components/Toolkit.jsx';
import Pipeline from './components/Pipeline.jsx';
import AutoTrade from './components/AutoTrade.jsx';
import Edge from './components/Edge.jsx';
import Pricing from './components/Pricing.jsx';
import Vision from './components/Vision.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main>
        <Hero />
        <Ticker />
        <Problem />
        <Features />
        <SignalAnatomy />
        <Toolkit />
        <Pipeline />
        <AutoTrade />
        <Edge />
        <Pricing />
        <Vision />
      </main>
      <Footer />
    </div>
  );
}
