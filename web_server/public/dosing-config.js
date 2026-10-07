// 台架起始值，不是泵/管路已标定参数。每次启动显式提交完整快照。
(function(root) {
  const ranges = {
    version:[1,2147483647],minimum_percent:[40,100],fast_percent:[40,100],slow_percent:[40,100],fine_percent:[40,100],air_percent:[1,100],
    route_ms:[100,5000],purge_ms:[100,10000],settle_min_ms:[200,60000],settle_timeout_ms:[201,60000],step_timeout_ms:[1000,600000],
    total_timeout_ms:[1000,3600000],no_flow_ms:[500,600000],pulse_min_ms:[60,1000],pulse_max_ms:[60,1000],max_jogs:[1,100],tail_ms:[0,5000],
    slow_margin_mg:[1,10000000],fine_margin_mg:[1,10000000],compensation_mg:[0,10000000],max_flow_mg_s:[1,10000000],
    progress_mg:[1,1000000],residual_limit_mg:[0,10000000],balance_tolerance_mg:[1,1000000],vessel_capacity_mg:[1,1000000000],purge_leak_tolerance_mg:[1,1000000]
  };
  const defaults = {version:1,minimum_percent:40,fast_percent:75,slow_percent:50,fine_percent:45,air_percent:60,
    route_ms:1000,purge_ms:1500,settle_min_ms:800,settle_timeout_ms:10000,step_timeout_ms:120000,total_timeout_ms:600000,no_flow_ms:5000,
    pulse_min_ms:80,pulse_max_ms:300,max_jogs:20,tail_ms:150,slow_margin_mg:5000,fine_margin_mg:1000,compensation_mg:100,
    max_flow_mg_s:50000,progress_mg:100,residual_limit_mg:3000,balance_tolerance_mg:500,vessel_capacity_mg:500000,purge_leak_tolerance_mg:200};
  function valid(p) {
    return p && !Array.isArray(p) && Object.keys(p).length===Object.keys(ranges).length &&
      Object.entries(ranges).every(([key,[min,max]])=>Number.isSafeInteger(p[key]) && p[key]>=min && p[key]<=max) &&
      p.minimum_percent<=p.fine_percent && p.fine_percent<=p.slow_percent && p.slow_percent<=p.fast_percent &&
      p.settle_timeout_ms>p.settle_min_ms && p.step_timeout_ms>p.settle_timeout_ms && p.total_timeout_ms>=p.step_timeout_ms &&
      p.no_flow_ms<=p.step_timeout_ms && p.pulse_min_ms<=p.pulse_max_ms && p.slow_margin_mg>=p.fine_margin_mg && p.compensation_mg<=p.fine_margin_mg;
  }
  const api={ranges,defaults,valid};
  if(typeof module!=='undefined')module.exports=api; else root.DosingConfig=api;
})(typeof globalThis!=='undefined'?globalThis:this);
