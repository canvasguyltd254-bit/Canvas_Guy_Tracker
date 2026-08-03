"use client";
import{useState,useEffect,useCallback}from"react";
import{createClient}from"@/shared/supabase/client";
import{useAuth}from"@/shared/context/AuthContext";
import{ALL_STATUS_COLORS,ss,ROLES_CAN_ADVANCE}from"@/modules/orders/components/constants";
import{C,PageHeader,TInput,Modal,Btn,Mono,Loading}from"@/shared/ui/ds";

const PROD_STAGES=["Material Check","Production","Quality Control","Ready for Delivery"];
const STAGE_ICONS={"Material Check":"📦","Production":"🔨","Quality Control":"🔍","Ready for Delivery":"✅"};

export default function ProductionBoard(){
  const[orders,setOrders]=useState([]);const[items,setItems]=useState({});const[loaded,setLoaded]=useState(false);
  const[viewMode,setViewMode]=useState("board");const[search,setSearch]=useState("");
  const[qcPrompt,setQcPrompt]=useState(null);const[qcNotes,setQcNotes]=useState("");const[qcBy,setQcBy]=useState("");
  const{userRole='viewer',displayName}=useAuth();
  const[exportMode,setExportMode]=useState(null);const[exportClient,setExportClient]=useState("");const[exportOrder,setExportOrder]=useState("");const[exporting,setExporting]=useState(false);
  const sb=createClient();

  useEffect(()=>{if(displayName)setQcBy(displayName)},[displayName]);

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
      const{data:pays}=await sb.from("order_payments").select("order_id,amount").in("order_id",ids).is("reversed_at",null);
      const payMap={};if(pays)pays.forEach(p=>{payMap[p.order_id]=(payMap[p.order_id]||0)+parseFloat(p.amount)});
      // Build workload summary for weekly
      let wl=null;
      if(mode==="weekly"){const cm={};exportOrders.forEach(o=>{(itemMap[o.id]||[]).forEach(i=>{const cat=i.category||"Other";cm[cat]=(cm[cat]||0)+(i.quantity||1)})});wl=Object.entries(cm).map(([label,qty])=>({label,qty})).filter(x=>x.qty>0)}
      const res=await fetch("/api/reports/pdf",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reportLabel:title+(subtitle?` — ${subtitle}`:""),orders:exportOrders,allItems:itemMap,payTotals:payMap,userName:qcBy,showFinancials:false,workloadSummary:wl,dateFrom:null,dateTo:null})});
      if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.detail||e.error||"PDF generation failed")}
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=`${title.replace(/[^a-zA-Z0-9]/g,"_")}_${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();URL.revokeObjectURL(url);
    }catch(err){alert("PDF error: "+err.message)}
    setExporting(false);setExportMode(null);
  };

  const prodClients=[...new Set(orders.map(o=>o.client))].sort();

  const filtered=search?orders.filter(o=>[o.client,o.order_num,o.items,o.assigned_to].filter(Boolean).join(" ").toLowerCase().includes(search.toLowerCase())):orders;
  const totalUnits=orders.reduce((s,o)=>s+(items[o.id]?.qty||0),0);
  const stageCounts=PROD_STAGES.reduce((a,s)=>{a[s]=orders.filter(o=>o.status===s).length;return a},{});

  if(!loaded)return <Loading/>;

  const renderCard=(order)=>{
    const c2=ALL_STATUS_COLORS[order.status]||{};
    const days=order.due_date?Math.ceil((new Date(order.due_date+"T12:00:00")-now)/86400000):null;
    const overdue=days!==null&&days<0;
    const iS=items[order.id];
    const idx=PROD_STAGES.indexOf(order.status);
    const next=idx<PROD_STAGES.length-1?PROD_STAGES[idx+1]:null;

    return(<div key={order.id} style={{background:C.card,borderRadius:C.radius,border:`1.5px solid ${overdue?C.redBd:C.line}`,borderLeft:`4px solid ${c2.text||C.muted}`,padding:"14px 16px",boxShadow:"0 1px 3px rgba(0,0,0,0.06)",marginBottom:"8px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
        <Mono style={{fontSize:"12px",color:C.muted,background:C.bg,padding:"2px 8px",borderRadius:"4px",border:`1px solid ${C.line}`}}>{order.order_num}</Mono>
        <Mono style={{fontSize:"11px",color:overdue?C.red:C.muted,fontWeight:overdue?700:400}}>{order.due_date?new Date(order.due_date+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"}):"No date"}{overdue&&` · ${Math.abs(days)}d late`}</Mono>
      </div>
      <div style={{fontSize:"15px",fontWeight:700,color:overdue?C.red:C.ink,marginBottom:"4px",letterSpacing:"-0.3px"}}>{order.client}</div>
      {iS?<div style={{fontSize:"12px",color:C.muted,marginBottom:"6px"}}>{Object.entries(iS.cats).map(([cat,q])=>`${q}x ${cat}`).join(" · ")}<span style={{marginLeft:"4px"}}>({iS.qty} units)</span></div>:<div style={{fontSize:"12px",color:C.muted,marginBottom:"6px"}}>{order.items}</div>}
      {order.assigned_to&&<div style={{fontSize:"11px",color:C.muted,marginBottom:"8px"}}>Assigned: <strong style={{color:C.ink}}>{order.assigned_to}</strong></div>}
      {canAdvance&&next&&<button onClick={()=>advance(order,next)} style={{padding:"8px 16px",border:"none",borderRadius:C.radiusSm,background:c2.text||C.ink,color:"#fff",fontSize:"12px",fontWeight:700,cursor:"pointer",width:"100%",transition:"all 0.1s",fontFamily:"inherit"}}>{STAGE_ICONS[next]||"→"} Move to {next}</button>}
      {!next&&<div style={{fontSize:"12px",color:C.green,fontWeight:700,textAlign:"center",padding:"6px 0"}}>✓ Ready for delivery</div>}
    </div>);
  };

  const pdfActions = (
    <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
      <Btn small onClick={()=>handleProdExport("weekly")} disabled={exporting}>{exporting?"…":"PDF: Weekly"}</Btn>
      <Btn small onClick={()=>setExportMode("client")}>PDF: Client</Btn>
      <Btn small onClick={()=>setExportMode("order")}>PDF: Order</Btn>
    </div>
  );

  const viewToggle = (
    <div style={{display:"flex",gap:"4px",border:`1.5px solid ${C.line}`,borderRadius:C.radiusSm,padding:2,background:C.card}}>
      {["board","list"].map(v=>(
        <button key={v} onClick={()=>setViewMode(v)} style={{padding:"5px 14px",borderRadius:6,border:"none",background:viewMode===v?C.ink:"transparent",color:viewMode===v?"#fff":C.muted,fontSize:"12px",fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s",textTransform:"capitalize"}}>{v}</button>
      ))}
    </div>
  );

  return(<div style={{padding:"20px 16px",color:C.ink}}>
    {/* QC Gate Modal */}
    {qcPrompt&&<Modal title="QC Approval Required" onClose={()=>setQcPrompt(null)} footer={<><Btn onClick={()=>setQcPrompt(null)}>Cancel</Btn><Btn primary onClick={confirmQc}>✓ Approve & Advance</Btn></>}>
      <p style={{fontSize:"13px",color:C.muted,marginBottom:"16px"}}>Confirm quality inspection for <Mono>{qcPrompt.order.order_num}</Mono> — {qcPrompt.order.client}</p>
      <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
        <div><label style={ss.label}>Inspected By</label><input type="text" value={qcBy} onChange={e=>setQcBy(e.target.value)} style={ss.input}/></div>
        <div><label style={ss.label}>QC Notes (defects, observations)</label><textarea value={qcNotes} onChange={e=>setQcNotes(e.target.value)} rows={3} style={{...ss.input,resize:"vertical"}} placeholder="e.g. All 176 pieces inspected. 2 minor finish touch-ups completed."/></div>
      </div>
    </Modal>}

    {/* Export picker modal */}
    {exportMode&&<Modal title={exportMode==="client"?"Client Production PDF":"Order Production PDF"} onClose={()=>{setExportMode(null);setExportClient("");setExportOrder("")}} footer={<><Btn onClick={()=>{setExportMode(null);setExportClient("");setExportOrder("")}}>Cancel</Btn><Btn primary disabled={exporting||(exportMode==="client"&&!exportClient)||(exportMode==="order"&&!exportOrder)} onClick={()=>handleProdExport(exportMode,exportMode==="client"?exportClient:exportOrder)}>{exporting?"Generating…":"Download PDF"}</Btn></>}>
      {exportMode==="client"&&<div>
        <label style={ss.label}>Select Client</label>
        <select value={exportClient} onChange={e=>setExportClient(e.target.value)} style={{...ss.input,cursor:"pointer"}}>
          <option value="">Choose a client…</option>
          {prodClients.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
      </div>}
      {exportMode==="order"&&<div>
        <label style={ss.label}>Select Order</label>
        <select value={exportOrder} onChange={e=>setExportOrder(e.target.value)} style={{...ss.input,cursor:"pointer"}}>
          <option value="">Choose an order…</option>
          {orders.map(o=><option key={o.id} value={o.order_num}>{o.order_num} — {o.client}</option>)}
        </select>
      </div>}
    </Modal>}

    <PageHeader title="Production" description={`${orders.length} orders · ${totalUnits} units in pipeline`} actions={<div style={{display:"flex",gap:"10px",alignItems:"center"}}>{pdfActions}{viewToggle}</div>} />

    {/* Stage summary strip */}
    <div style={{display:"flex",gap:"8px",marginBottom:"16px",overflowX:"auto",paddingBottom:"4px"}}>
      {PROD_STAGES.map(s=>{const c2=ALL_STATUS_COLORS[s];return <div key={s} style={{padding:"10px 14px",borderRadius:C.radiusSm,background:C.card,border:`1.5px solid ${c2.border}`,borderLeft:`4px solid ${c2.text}`,flex:"1 1 0",minWidth:"120px",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}><Mono style={{fontSize:"22px",fontWeight:800,color:c2.text,display:"block"}}>{stageCounts[s]}</Mono><div style={{fontSize:"11px",color:C.muted,fontWeight:600,marginTop:2}}>{s}</div></div>})}
    </div>

    <TInput type="text" placeholder="Search orders…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:"320px",marginBottom:"16px"}}/>

    {/* Board View */}
    {viewMode==="board"&&(
      <div className="prod-board" style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",gap:"12px",alignItems:"start"}}>
        {PROD_STAGES.map(stage=>{
          const c2=ALL_STATUS_COLORS[stage];
          const stageOrders=filtered.filter(o=>o.status===stage);
          return(<div key={stage}>
            <div style={{padding:"10px 12px",borderRadius:`${C.radiusSm}px ${C.radiusSm}px 0 0`,background:c2.bg,borderBottom:`3px solid ${c2.text}`,marginBottom:"8px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:"13px",fontWeight:700,color:c2.text}}>{STAGE_ICONS[stage]} {stage}</span>
                <Mono style={{fontSize:"14px",fontWeight:800,color:c2.text}}>{stageOrders.length}</Mono>
              </div>
            </div>
            {stageOrders.length===0?<div style={{padding:"20px",textAlign:"center",fontSize:"12px",color:C.muted,background:C.bg,borderRadius:C.radiusSm,border:`1px dashed ${C.line}`}}>No orders</div>:stageOrders.map(o=>renderCard(o))}
          </div>);
        })}
      </div>
    )}

    {/* List View */}
    {viewMode==="list"&&(
      <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
        {filtered.length===0?<div style={{textAlign:"center",padding:"40px",color:C.muted,background:C.card,borderRadius:C.radius}}>No orders in production</div>:filtered.map(o=>renderCard(o))}
      </div>
    )}

    <style>{`
      @media(max-width:768px){
        .prod-board{grid-template-columns:1fr!important}
      }
    `}</style>
  </div>);
}
