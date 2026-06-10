"use client";
import{useState,useEffect}from"react";
import Link from"next/link";
import{createClient}from"@/shared/supabase/client";
import{ALL_STATUS_COLORS}from"@/modules/orders/components/constants";

export default function Dashboard(){
  const[orders,setOrders]=useState([]);const[activities,setActivities]=useState([]);const[loaded,setLoaded]=useState(false);
  const[itemSums,setItemSums]=useState({});const[delTotals,setDelTotals]=useState({});const[payTotals,setPayTotals]=useState({});
  const sb=createClient();

  useEffect(()=>{(async()=>{
    const{data:ord}=await sb.from("orders").select("*").order("created_at",{ascending:false});setOrders(ord||[]);
    const{data:acts}=await sb.from("order_activities").select("*").order("created_at",{ascending:false}).limit(20);setActivities(acts||[]);
    const{data:items}=await sb.from("order_items").select("order_id,quantity");if(items){const m={};items.forEach(i=>{m[i.order_id]=(m[i.order_id]||0)+(i.quantity||1)});setItemSums(m)}
    const{data:dels}=await sb.from("order_deliveries").select("order_id,quantity");
    const{data:pays}=await sb.from("order_payments").select("order_id,amount");
    if(pays){const t={};pays.forEach(p=>{t[p.order_id]=(t[p.order_id]||0)+parseFloat(p.amount)});setPayTotals(t)}if(dels){const t={};dels.forEach(d=>{t[d.order_id]=(t[d.order_id]||0)+(d.quantity||0)});setDelTotals(t)}
    setLoaded(true);
  })()},[]);

  if(!loaded)return <div style={{padding:"40px",textAlign:"center",color:"#aaa"}}>Loading...</div>;

  const now=new Date();const we=new Date(now);we.setDate(now.getDate()+7);
  const active=orders.filter(o=>!["Closed","Delivered","Redelivered"].includes(o.status));
  const inProd=orders.filter(o=>o.status==="Production");
  const matCheck=orders.filter(o=>o.status==="Material Check");
  const dueWeek=orders.filter(o=>{if(!o.due_date||["Delivered","Closed"].includes(o.status))return false;const d=new Date(o.due_date+"T12:00:00");return d>=now&&d<=we});
  const overdue=orders.filter(o=>{if(!o.due_date||["Delivered","Closed"].includes(o.status))return false;return new Date(o.due_date+"T12:00:00")<now});
  const completed=orders.filter(o=>o.status==="Delivered"||o.status==="Closed");
  // New V7 metrics
  const outstandingReceivables=orders.filter(o=>!["Closed"].includes(o.status)).reduce((s,o)=>{const tv=parseFloat(o.total_value)||0;const tp=payTotals[o.id]||0;return s+Math.max(tv-tp,0)},0);
  const thisWeekStart=new Date(now);thisWeekStart.setDate(now.getDate()-now.getDay());thisWeekStart.setHours(0,0,0,0);
  const salesThisWeek=orders.filter(o=>new Date(o.created_at)>=thisWeekStart).reduce((s,o)=>s+(parseFloat(o.total_value)||0),0);
  const prodUnits=orders.filter(o=>["Production","Quality Control","Material Check"].includes(o.status)).reduce((s,o)=>s+(itemSums[o.id]||0),0);
  const collectionsDue=orders.filter(o=>{if(!o.due_date||["Closed"].includes(o.status))return false;const tv=parseFloat(o.total_value)||0;const tp=payTotals[o.id]||0;if(tp>=tv)return false;const d=new Date(o.due_date+"T12:00:00");return d>=now&&d<=we}).reduce((s,o)=>{const tv=parseFloat(o.total_value)||0;const tp=payTotals[o.id]||0;return s+Math.max(tv-tp,0)},0);
  const stalled=orders.filter(o=>{if(["Delivered","Closed"].includes(o.status))return false;return(now-new Date(o.updated_at))/86400000>3});
  const partDel=orders.filter(o=>o.status==="Partially Delivered"||o.status==="Ready for Delivery").filter(o=>{const tq=itemSums[o.id]||0;const td=delTotals[o.id]||0;return tq>0&&td>0&&td<tq});

  const alerts=[
    ...stalled.map(o=>({icon:"⏸",color:"#FF6F00",text:`${o.order_num} — ${o.client} stalled ${Math.floor((now-new Date(o.updated_at))/86400000)}d`})),
    ...overdue.map(o=>({icon:"🔴",color:"#C62828",text:`${o.order_num} — ${o.client} overdue since ${new Date(o.due_date+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`})),
    ...partDel.map(o=>({icon:"🚚",color:"#1565C0",text:`${o.order_num} — ${o.client} partially delivered (${delTotals[o.id]}/${itemSums[o.id]} units)`})),
  ];

  const card={background:"#fff",borderRadius:"10px",padding:"20px",border:"1.5px solid #E0DDD8",flex:"1 1 160px",minWidth:"140px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)",transition:"all 0.15s",textDecoration:"none"};
  const weekDays=[];for(let i=0;i<7;i++){const d=new Date(now);d.setDate(now.getDate()+i);weekDays.push({date:d,orders:orders.filter(o=>{if(!o.due_date)return false;return new Date(o.due_date+"T12:00:00").toDateString()===d.toDateString()})});}

  return(<div style={{padding:"20px 16px"}}>
    <h1 style={{fontSize:"24px",fontWeight:800,marginBottom:"20px",letterSpacing:"-0.5px"}}>Dashboard</h1>
    <div className="dash-cards" style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:"12px",marginBottom:"24px"}}>
      {[{l:"Total Orders",v:orders.length,c:"#1a1a1a",h:"/orders"},{l:"In Production",v:inProd.length,c:"#E65100",h:"/reports?type=production"},{l:"Due This Week",v:dueWeek.length,c:"#1565C0",h:"/reports?type=due-week"},{l:"Overdue",v:overdue.length,c:overdue.length>0?"#C62828":"#999",h:"/reports?type=overdue"},{l:"Outstanding (KES)",v:outstandingReceivables>0?""+Math.round(outstandingReceivables/1000)+"K":"0",c:"#7B1FA2",h:"/reports?type=receivables"},{l:"Sales This Week",v:salesThisWeek>0?""+Math.round(salesThisWeek/1000)+"K":"0",c:"#1565C0",h:"/reports?type=sales-week"},{l:"Prod Units",v:prodUnits,c:"#E65100",h:"/reports?type=workload"},{l:"Completed",v:completed.length,c:"#2E7D32",h:"/orders?status=Delivered"}].map(x=><Link key={x.l} href={x.h} style={{...card,textDecoration:"none",cursor:"pointer",transition:"all 0.15s"}}><div style={{fontSize:"32px",fontWeight:800,color:x.c,fontFamily:"'DM Mono',monospace",letterSpacing:"-1px"}}>{x.v}</div><div style={{fontSize:"12px",color:"#888",marginTop:"4px",fontWeight:500}}>{x.l}</div></Link>)}
    </div>
    <div className="dash-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"20px"}}>
      <div style={{background:"#fff",borderRadius:"10px",padding:"20px",border:"1px solid #e8e8e5"}}><h3 style={{fontSize:"14px",fontWeight:700,marginBottom:"14px"}}>📅 This Week</h3>
        {weekDays.map(({date,orders:d})=>{const isToday=date.toDateString()===now.toDateString();return <div key={date.toISOString()} style={{display:"flex",gap:"10px",padding:"8px 12px",borderRadius:"6px",background:isToday?"#FFFDE7":"transparent",border:isToday?"1px solid #FFD54F":"1px solid transparent"}}><div style={{width:"50px",flexShrink:0}}><div style={{fontSize:"10px",color:"#999",fontWeight:600,textTransform:"uppercase"}}>{date.toLocaleDateString("en-GB",{weekday:"short"})}</div><div style={{fontSize:"18px",fontWeight:700,color:isToday?"#F57F17":"#333",fontFamily:"'DM Mono',monospace"}}>{date.getDate()}</div></div><div style={{flex:1}}>{d.length===0?<div style={{fontSize:"12px",color:"#ccc",paddingTop:"4px"}}>No deadlines</div>:d.map(o=>{const isOd=new Date(o.due_date+"T12:00:00")<now&&!["Delivered","Closed"].includes(o.status);return <div key={o.id} style={{fontSize:"12px",color:isOd?"#C62828":"#333",padding:"2px 0",fontWeight:isOd?600:400}}><span style={{color:isOd?"#C62828":(ALL_STATUS_COLORS[o.status]?.text||"#999"),fontWeight:700}}>●</span> {o.order_num} — {o.client}{isOd&&" ⚠"}</div>})}</div></div>})}
      </div>
      <div style={{background:"#fff",borderRadius:"10px",padding:"20px",border:"1px solid #e8e8e5"}}><h3 style={{fontSize:"14px",fontWeight:700,marginBottom:"14px"}}>⚠️ Alerts ({alerts.length})</h3>
        {alerts.length===0?<div style={{fontSize:"13px",color:"#bbb",padding:"20px 0",textAlign:"center"}}>All clear.</div>:<div style={{display:"flex",flexDirection:"column",gap:"6px",maxHeight:"240px",overflowY:"auto"}}>{alerts.map((a,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:"10px",padding:"10px 12px",borderRadius:"6px",background:"#FFFBF0",border:`1px solid ${a.color}22`}}><span style={{fontSize:"16px"}}>{a.icon}</span><span style={{fontSize:"12px",color:"#333",flex:1}}>{a.text}</span></div>)}</div>}
        <h3 style={{fontSize:"14px",fontWeight:700,margin:"24px 0 14px"}}>🕐 Recent Activity</h3>
        {activities.length===0?<div style={{fontSize:"13px",color:"#bbb",textAlign:"center"}}>No activity.</div>:<div style={{display:"flex",flexDirection:"column",gap:"4px",maxHeight:"200px",overflowY:"auto"}}>{activities.slice(0,10).map(a=><div key={a.id} style={{fontSize:"12px",color:"#666",padding:"4px 0",borderBottom:"1px solid #f5f5f5"}}><span style={{color:"#999"}}>{new Date(a.created_at).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span> {a.description}</div>)}</div>}
      </div>
    </div>
    <Link href="/contacts" style={{display:"flex",alignItems:"center",gap:"12px",marginTop:"20px",padding:"16px 20px",background:"#fff",borderRadius:"10px",border:"1px solid #e8e8e5",textDecoration:"none",color:"#333",transition:"all 0.15s"}}><span style={{fontSize:"20px"}}>📇</span><div><div style={{fontSize:"14px",fontWeight:600}}>Supplier &amp; Service Contacts</div><div style={{fontSize:"12px",color:"#999",marginTop:"2px"}}>View the team contact directory</div></div><span style={{marginLeft:"auto",color:"#ccc",fontSize:"18px"}}>→</span></Link>
    <style>{`@media(max-width:768px){.dash-grid{grid-template-columns:1fr!important}}`}</style>
  </div>);
}
