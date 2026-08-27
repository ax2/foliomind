import { BookmarkSimple, DotsThree, SlidersHorizontal } from "@phosphor-icons/react";
import { stocks } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";
import { MarketChart } from "./MarketChart.jsx";

const ranges = ["分时", "5日", "日K", "周K", "月K", "季K", "年K"];

export function StockWorkspace() {
  const symbol = useLabStore((state) => state.selectedSymbol);
  const chartRange = useLabStore((state) => state.chartRange);
  const setChartRange = useLabStore((state) => state.setChartRange);
  const stock = stocks[symbol] ?? stocks["600519"];
  return (
    <main className="stock-workspace">
      <header className="stock-header">
        <div><div className="stock-mark">{stock.name.slice(0, 1)}</div><h1>{stock.name}<span>{stock.symbol}</span></h1><small>{stock.market}</small><small>{stock.category}</small></div>
        <div><button aria-label="收藏"><BookmarkSimple size={20} /></button><button aria-label="更多"><DotsThree size={22} /></button></div>
      </header>
      <section className="quote-overview">
        <div className={stock.change >= 0 ? "primary-price up" : "primary-price down"}>{stock.price.toFixed(2)} <span>{stock.change >= 0 ? "+" : ""}{(stock.price * stock.change / 100).toFixed(2)}　{stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%</span><small>已收盘　08-27 15:00:00 CST</small></div>
        <div className="quote-stats">
          <dl><dt>今开</dt><dd>1,554.00</dd><dt>昨收</dt><dd>1,555.66</dd><dt>最高</dt><dd className="up">1,573.66</dd><dt>最低</dt><dd className="down">1,545.00</dd></dl>
          <dl><dt>成交量</dt><dd>12.45万手</dd><dt>成交额</dt><dd>195.08亿</dd><dt>换手率</dt><dd>0.10%</dd><dt>量比</dt><dd>0.98</dd></dl>
          <dl><dt>市盈率(TTM)</dt><dd>27.18</dd><dt>市净率(LF)</dt><dd>9.08</dd><dt>总市值</dt><dd>19,687亿</dd><dt>流通市值</dt><dd>19,687亿</dd></dl>
        </div>
      </section>
      <section className="chart-section">
        <div className="range-tabs">{ranges.map((range) => <button key={range} className={chartRange === range ? "active" : ""} onClick={() => setChartRange(range)}>{range}</button>)}<button className="chart-settings"><SlidersHorizontal size={18} /></button></div>
        <MarketChart />
      </section>
      <section className="fundamentals"><h3>关键指标</h3><div>{[["营业收入(元)", "1,742.28亿", "+16.27%"], ["净利润(元)", "862.28亿", "+15.73%"], ["毛利率", "92.51%", "+0.68pp"], ["净利率", "49.53%", "-0.15pp"], ["ROE", "33.58%", "-0.42pp"]].map(([label, value, delta]) => <dl key={label}><dt>{label}</dt><dd>{value}</dd><small>同比 {delta}</small></dl>)}</div></section>
      <section className="company-intro"><h3>公司简介</h3><p>贵州茅台酒股份有限公司主要从事茅台酒系列产品的生产与销售，主营产品贵州茅台酒是中国高端白酒的代表，享有“国酒”美誉。</p><button>展开</button></section>
      <footer className="source-line">数据来自 QVeris　　截至 2026-08-27 15:00 CST</footer>
    </main>
  );
}
