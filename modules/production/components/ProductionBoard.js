"use client";
import{useState,useEffect,useCallback}from"react";
import{createClient}from"@/shared/supabase/client";
import{ALL_STATUS_COLORS,ss,ROLES_CAN_ADVANCE}from"@/modules/orders/components/constants";
import{generateReportPDF}from"@/shared/pdf/generateReport";

const PROD_STAGES=["Material Check","Production","Quality Control","Ready for Delivery"];
const STAGE_ICONS={"Material Check":"📦","Production":"🔨","Quality Control":"🔍","Ready for Delivery":"✅"};

export default function ProductionBoard(){
  const[orders,setOrders]=useState([]);const[items,setItems]=useState({});const[loaded,setLoaded]=useState(false);
  const[viewMode,setViewMode]=useState("board");const[search,setSearch]=useState("");
  const[qcPrompt,setQcPrompt]=useState(null);const[qcNotes,setQcNotes]=useState("");const[qcBy,setQcBy]=useState("");
  const[userRole,setUserRole]=useState("viewer");
  const[exportMode,setExportMode]=useState(null);const[exportClient,setExportClient]=useState("");const[exportOrder,setExportOrder]=useState("");const[exporting,setExporting]=useState(false);
  const sb=createClient();

  useEffect(()=>{(async()=>{const{data:{user}}=await sb.auth.getUser();if(user){const{data:p}=await sb.from("user_profiles").select("role,display_name").eq("id",user.id).single();if(p){setUserRole(p.role);setQcBy(p.display_name||user.email?.split("@")[0]||"")}}})()},[]);

  const load=useCallback(async()=>{
    const{data:ord}=await sb.from("orders").select("*").in("status",PROD_STAGES).order("due_date",{ascending:true,nullsFirst:false});setOrders(ord||[]);
    const{data:itms}=await sb.from("order_items").select("order_id,category,quantity");
    if(itms){const m={};itms.forEach(i=>{if(!m[i.order_id])m[i.order_id]={qty:0,cats:{}};m[i.order_id].qty+=(i.quantity||1);m[i.order_id].cats[i.category]=(m[i.order_id].cats[i.category]||0)+(i.quantity||1)});setItems(m)}
    setLoaded(true);
  },[]);
  useEffect(()=>{load()},[load]);

  const canAdvance=ROLES_CAN_ADVANCE.includes(userRole);
  const now=new Date();

  const advance=async(order,nextStatus)=>{
    // QC Gate: require confirmation before advancing from QC
    if(order.status==="Quality Control"){setQcPrompt({order,nextStatus});return}
    await sb.from("orders").update({status:nextStatus}).eq("id",order.id);
    await sb.from("order_activities").insert({order_id:order.id,activity_type:"status_change",description:`Production: ${order.status} → ${nextStatus}`,old_value:order.status,new_value:nextStatus});
    await load();
  };

  const confirmQc=async()=>{
    if(!qcPrompt)return;
    const{order,nextStatus}=qcPrompt;
    await sb.from("orders").update({status:nextStatus}).eq("id",order.id);
    await sb.from("order_activities").insert({order_id:order.id,activity_type:"qc_approved",description:`QC Approved by ${qcBy}${qcNotes?" — "+qcNotes:""}. Moved to ${nextStatus}`});
    if(qcNotes){await sb.from("order_notes").insert({order_id:order.id,content:`QC: ${qcNotes}`,author_name:qcBy})}
    setQcPrompt(null);setQcNotes("");await load();
  };

  const handleProdExport=async(mode,filterVal)=>{
    setExporting(true);
    try{
      let exportOrders=orders;
      let subtitle="All Production Stages";
      let title="Production Report";
      if(mode==="client"&&filterVal){exportOrders=orders.filter(o=>o.client===filterVal);subtitle=`Client: ${filterVal}`;title="Client Production Report"}
      if(mode==="order"&&filterVal){exportOrders=orders.filter(o=>o.order_num===filterVal);subtitle=`Order: ${filterVal}`;title="Order Production Report"}
      if(mode==="weekly"){title="Weekly Production Report";subtitle=`Week of ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}`}
      // Fetch full item details for the PDF
      const ids=exportOrders.map(o=>o.id);
      const{data:fullItems}=await sb.from("order_items").select("*").in("order_id",ids).order("sort_order");
      const itemMap={};if(fullItems)fullItems.forEach(i=>{if(!itemMap[i.order_id])itemMap[i.order_id]=[];itemMap[i.order_id].push(i)});
      const{data:pays}=await sb.from("order_payments").select("order_id,amount").in("order_id",ids);
      const payMap={};if(pays)pays.forEach(p=>{payMap[p.order_id]=(payMap[p.order_id]||0)+parseFloat(p.amount)});
      // Build workload summary for weekly
      let wl=null;
      if(mode==="weekly"){const cm={};exportOrders.forEach(o=>{(itemMap[o.id]||[]).forEach(i=>{const cat=i.category||"Other";cm[cat]=(cm[cat]||0)+(i.quantity||1)})});wl=Object.entries(cm).map(([label,qty])=>({label,qty})).filter(x=>x.qty>0)}
      await generateReportPDF({title,subtitle,orders:exportOrders,allItems:itemMap,payTotals:payMap,userName:qcBy,showFinancials:false,workloadSummary:wl});
    }catch(err){alert("PDF error: "+err.message)}
    setExporting(false);setExportMode(null);
  };

  const prodClients=[...new Set(orders.map(o=>o.client))].sort();

  const filtered=search?orders.filter(o=>[o.client,o.order_num,o.items,o.assigned_to].filter(Boolean).join(" ").toLowerCase().includes(search.toLowerCase())):orders;
  const totalUnits=orders.reduce((s,o)=>s+(items[o.id]?.qty||0),0);
  const stageCounts=PROD_STAGES.reduce((a,s)=>{a[s]=orders.filter(o=>o.status===s).length;return a},{});

  if(!loaded)return <div style={{padding:"40px",textAlign:"center",color:"#aaa"}}>Loading...</div>;

  const renderCard=(order)=>{
    const c2=ALL_STATUS_COLORS[order.status]||{};
    const days=order.due_date?Math.ceil((new Date(order.due_date+"T12:00:00")-now)/86400000):null;
    const overdue=days!==null&&days<0;
    const iS=items[order.id];
    const idx=PROD_STAGES.indexOf(order.status);
    const next=idx<PROD_STAGES.length-1?PROD_STAGES[idx+1]:null;

    return(<div key={order.id} style={{background:"#fff",borderRadius:"10px",border:`1.5px solid ${overdue?"#FCA5A5":"#E0DDD8"}`,borderLeft:`4px solid ${c2.text||"#999"}`,padding:"14px 16px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:"8px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
        <span style={{fontSize:"12px",fontFamily:"'DM Mono',monospace",color:"#888",background:"#F0EDE8",padding:"2px 8px",borderRadius:"4px",fontWeight:500}}>{order.order_num}</span>
        <span style={{fontSize:"11px",color:overdue?"#DC2626":"#999",fontWeight:overdue?700:400}}>{order.due_date?new Date(order.due_date+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"}):"No date"}{overdue&&` · ${Math.abs(days)}d late`}</span>
      </div>
      <div style={{fontSize:"15px",fontWeight:700,color:overdue?"#DC2626":"#111",marginBottom:"4px",letterSpacing:"-0.3px"}}>{order.client}</div>
      {iS?<div style={{fontSize:"12px",color:"#666",marginBottom:"6px"}}>{Object.entries(iS.cats).map(([cat,q])=>`${q}x ${cat}`).join(" · ")}<span style={{color:"#999",marginLeft:"4px"}}>({iS.qty} units)</span></div>:<div style={{fontSize:"12px",color:"#999",marginBottom:"6px"}}>{order.items}</div>}
      {order.assigned_to&&<div style={{fontSize:"11px",color:"#888",marginBottom:"8px"}}>Assigned: <strong>{order.assigned_to}</strong></div>}
      {canAdvance&&next&&<button onClick={()=>advance(order,next)} style={{padding:"8px 16px",border:"none",borderRadius:"6px",background:c2.text||"#111",color:"#fff",fontSize:"12px",fontWeight:700,cursor:"pointer",width:"100%",transition:"all 0.1s"}}>{STAGE_ICONS[next]||"→"} Move to {next}</button>}
      {!next&&<div style={{fontSize:"12px",color:"#16A34A",fontWeight:700,textAlign:"center",padding:"6px 0"}}>✓ Ready for delivery</div>}
    </div>);
  };

  return(<div style={{padding:"20px 16px"}}>
    {/* QC Gate Modal */}
    {qcPrompt&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}}><div style={{background:"#fff",borderRadius:"12px",padding:"24px",maxWidth:"420px",width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.2)"}}>
      <h3 style={{fontSize:"16px",fontWeight:700,marginBottom:"4px"}}>🔍 QC Approval Required</h3>
      <p style={{fontSize:"12px",color:"#888",marginBottom:"16px"}}>Confirm quality inspection for {qcPrompt.order.order_num} — {qcPrompt.order.client}</p>
      <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
        <div><label style={ss.label}>Inspected By</label><input type="text" value={qcBy} onChange={e=>setQcBy(e.target.value)} style={ss.input}/></div>
        <div><label style={ss.label}>QC Notes (defects, observations)</label><textarea value={qcNotes} onChange={e=>setQcNotes(e.target.value)} rows={3} style={{...ss.input,resize:"vertical"}} placeholder="e.g. All 176 pieces inspected. 2 minor finish touch-ups completed."/></div>
      </div>
      <div style={{display:"flex",gap:"10px",marginTop:"18px"}}>
        <button onClick={confirmQc} style={{...ss.btn,background:"#16A34A",color:"#fff",flex:1,fontSize:"14px",padding:"10px"}}>✓ Approve & Advance</button>
        <button onClick={()=>setQcPrompt(null)} style={{...ss.btn,background:"#f5f5f5",color:"#666"}}>Cancel</button>
      </div>
    </div></div>}

    {/* Header */}
    <div style={{marginBottom:"8px"}}>
      {/* Row 1: Title + View toggle — always one line */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px",gap:"10px"}}>
        <div>
          <h1 style={{fontSize:"22px",fontWeight:800,letterSpacing:"-0.5px",margin:0}}>Production</h1>
          <div style={{fontSize:"12px",color:"#999",marginTop:"2px"}}>{orders.length} orders · {totalUnits} units in pipeline</div>
        </div>
        {/* View toggle — compact, always fits */}
        <div style={{display:"flex",gap:"4px",flexShrink:0}}>
          <button onClick={()=>setViewMode("board")} style={{padding:"6px 14px",borderRadius:"6px",border:"1.5px solid "+(viewMode==="board"?"#111":"#E0DDD8"),background:viewMode==="board"?"#111":"#fff",color:viewMode==="board"?"#fff":"#888",fontSize:"12px",fontWeight:600,cursor:"pointer"}}>Board</button>
          <button onClick={()=>setViewMode("list")} style={{padding:"6px 14px",borderRadius:"6px",border:"1.5px solid "+(viewMode==="list"?"#111":"#E0DDD8"),background:viewMode==="list"?"#111":"#fff",color:viewMode==="list"?"#fff":"#888",fontSize:"12px",fontWeight:600,cursor:"pointer"}}>List</button>
        </div>
      </div>
      {/* Row 2: PDF exports — wraps gracefully on mobile */}
      <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
        <button onClick={()=>handleProdExport("weekly")} disabled={exporting} style={{padding:"5px 10px",borderRadius:"6px",border:"1.5px solid #E0DDD8",background:"#fff",color:"#666",fontSize:"11px",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>{exporting?"...":"📄 Weekly"}</button>
        <button onClick={()=>setExportMode("client")} style={{padding:"5px 10px",borderRadius:"6px",border:"1.5px solid #E0DDD8",background:"#fff",color:"#666",fontSize:"11px",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>📄 Client</button>
        <button onClick={()=>setExportMode("order")} style={{padding:"5px 10px",borderRadius:"6px",border:"1.5px solid #E0DDD8",background:"#fff",color:"#666",fontSize:"11px",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>📄 Order</button>
      </div>
    </div>

    {/* Export picker modal */}
    {exportMode&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"16px"}} onClick={()=>setExportMode(null)}><div style={{background:"#fff",borderRadius:"12px",padding:"24px",maxWidth:"380px",width:"100%"}} onClick={e=>e.stopPropagation()}>
      <h3 style={{fontSize:"16px",fontWeight:700,marginBottom:"14px"}}>{exportMode==="client"?"📄 Client Production PDF":"📄 Order Production PDF"}</h3>
      {exportMode==="client"&&<div>
        <label style={ss.label}>Select Client</label>
        <select value={exportClient} onChange={e=>setExportClient(e.target.value)} style={{...ss.input,cursor:"pointer"}}>
          <option value="">Choose a client...</option>
          {prodClients.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
      </div>}
      {exportMode==="order"&&<div>
        <label style={ss.label}>Select Order</label>
        <select value={exportOrder} onChange={e=>setExportOrder(e.target.value)} style={{...ss.input,cursor:"pointer"}}>
          <option value="">Choose an order...</option>
          {orders.map(o=><option key={o.id} value={o.order_num}>{o.order_num} — {o.client}</option>)}
        </select>
      </div>}
      <div style={{display:"flex",gap:"10px",marginTop:"18px"}}>
        <button disabled={exporting||(exportMode==="client"&&!exportClient)||(exportMode==="order"&&!exportOrder)} onClick={()=>handleProdExport(exportMode,exportMode==="client"?exportClient:exportOrder)} style={{...ss.btn,background:"#1a1a1a",color:"#fff",flex:1,opacity:(exportMode==="client"&&!exportClient)||(exportMode==="order"&&!exportOrder)?0.4:1}}>{exporting?"Generating...":"Download PDF"}</button>
        <button onClick={()=>{setExportMode(null);setExportClient("");setExportOrder("")}} style={{...ss.btn,background:"#f5f5f5",color:"#666"}}>Cancel</button>
      </div>
    </div></div>}

    {/* Stage summary strip */}
    <div style={{display:"flex",gap:"8px",marginBottom:"16px",overflowX:"auto",paddingBottom:"4px"}}>
      {PROD_STAGES.map(s=>{const c2=ALL_STATUS_COLORS[s];return <div key={s} style={{padding:"10px 14px",borderRadius:"8px",background:"#fff",border:`1.5px solid ${c2.border}`,borderLeft:`4px solid ${c2.text}`,flex:"1 1 0",minWidth:"120px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}><div style={{fontSize:"24px",fontWeight:800,color:c2.text,fontFamily:"'DM Mono',monospace"}}>{stageCounts[s]}</div><div style={{fontSize:"11px",color:"#888",fontWeight:500}}>{s}</div></div>})}
    </div>

    <input type="text" placeholder="Search orders..." value={search} onChange={e=>setSearch(e.target.value)} style={{...ss.input,maxWidth:"320px",background:"#fff",marginBottom:"16px"}}/>

    {/* Board View */}
    {viewMode==="board"&&(
      <div className="prod-board" style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:"12px",alignItems:"start"}}>
        {PROD_STAGES.map(stage=>{
          const c2=ALL_STATUS_COLORS[stage];
          const stageOrders=filtered.filter(o=>o.status===stage);
          return(<div key={stage}>
            <div style={{padding:"10px 12px",borderRadius:"8px 8px 0 0",background:c2.bg,borderBottom:`3px solid ${c2.text}`,marginBottom:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:"13px",fontWeight:700,color:c2.text}}>{STAGE_ICONS[stage]} {stage}</span>
                <span style={{fontSize:"14px",fontWeight:800,color:c2.text,fontFamily:"'DM Mono',monospace"}}>{stageOrders.length}</span>
              </div>
            </div>
            {stageOrders.length===0?<div style={{padding:"20px",textAlign:"center",fontSize:"12px",color:"#ccc",background:"#FAFAF8",borderRadius:"8px",border:"1px dashed #E0DDD8"}}>No orders</div>:stageOrders.map(o=>renderCard(o))}
          </div>);
        })}
      </div>
    )}

    {/* List View */}
    {viewMode==="list"&&(
      <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
        {filtered.length===0?<div style={{textAlign:"center",padding:"40px",color:"#bbb",background:"#fff",borderRadius:"10px"}}>No orders in production</div>:filtered.map(o=>renderCard(o))}
      </div>
    )}

    <style>{`
      @media(max-width:768px){
        .prod-board{grid-template-columns:1fr!important}
      }
    `}</style>
  </div>);
}
