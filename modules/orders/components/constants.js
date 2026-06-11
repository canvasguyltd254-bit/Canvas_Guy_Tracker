export const STATUSES = ["Inquiry","Quote Approved","Deposit Paid","Material Check","Production","Quality Control","Ready for Delivery","Partially Delivered","Delivered","Closed"];
export const REPAIR_STATUSES = ["Reported","Assessed","In Repair","QC","Redelivered","Closed"];
export const DELIVERY_VISIBLE_FROM = ["Ready for Delivery","Partially Delivered","Delivered","Closed"];
export const ALL_STATUS_COLORS = {
  "Inquiry":{bg:"#FFF8E1",text:"#F57F17",border:"#FFD54F"},"Quote Approved":{bg:"#E3F2FD",text:"#1565C0",border:"#64B5F6"},
  "Deposit Paid":{bg:"#EDE7F6",text:"#512DA8",border:"#9575CD"},"Material Check":{bg:"#FFF3E0",text:"#FF6F00",border:"#FFB74D"},
  "Production":{bg:"#FFF3E0",text:"#E65100",border:"#FFB74D"},"Quality Control":{bg:"#FCE4EC",text:"#C62828",border:"#EF9A9A"},
  "Ready for Delivery":{bg:"#E8F5E9",text:"#2E7D32",border:"#81C784"},"Partially Delivered":{bg:"#C8E6C9",text:"#1B5E20",border:"#66BB6A"},
  "Delivered":{bg:"#ECEFF1",text:"#546E7A",border:"#B0BEC5"},"Closed":{bg:"#F5F5F5",text:"#9E9E9E",border:"#E0E0E0"},
  "Reported":{bg:"#FCE4EC",text:"#C62828",border:"#EF9A9A"},"Assessed":{bg:"#FFF3E0",text:"#E65100",border:"#FFB74D"},
  "In Repair":{bg:"#FFF3E0",text:"#FF6F00",border:"#FFB74D"},"QC":{bg:"#FCE4EC",text:"#C62828",border:"#EF9A9A"},
  "Redelivered":{bg:"#E8F5E9",text:"#2E7D32",border:"#81C784"},
};
export const PAY_COLORS = {"Unpaid":{bg:"#FCE4EC",text:"#C62828",border:"#EF9A9A"},"Deposit Paid":{bg:"#FFF3E0",text:"#E65100",border:"#FFB74D"},"Partially Paid":{bg:"#E3F2FD",text:"#1565C0",border:"#64B5F6"},"Fully Paid":{bg:"#E8F5E9",text:"#2E7D32",border:"#81C784"}};
export const CATEGORIES = ["Wall Decoration Canvas","Mirrors","Furniture","Assorted Timber Products","Other"];
export const FINISH_TYPES = ["Stain","PU Hard Finish","One Coat","NC","None"];
export const WOOD_TYPES = ["Mahogany","Mvule","Mango","Muringa","Cypress","Teak","Pine","White Oak","MDF","Veneer","Laminated Board","Veneered Board","Plain Board"];
export const REPAIR_REASONS = ["Damage during delivery","Client rejects quality","Wrong specs produced","Post-delivery wear/warranty","Other"];
export const CUSTOMER_TYPES = [{id:"retail",label:"Retail Customer"},{id:"commercial",label:"Commercial Client"},{id:"reseller",label:"Reseller"}];
export const PAYMENT_TERMS = [{id:"cash_before",label:"Cash Before Production"},{id:"50_deposit",label:"50% Deposit"},{id:"30_day",label:"30 Day Credit"},{id:"60_day",label:"60 Day Credit"},{id:"custom",label:"Custom"}];
export const DOC_TYPES = ["Delivery Sheet","Invoice","Quotation","Job Card","Other"];
export const DOC_ICONS = {"Delivery Sheet":"🚚","Invoice":"🧾","Quotation":"💰","Job Card":"🔧","Other":"📎"};
export const ROLES_CAN_CREATE = ["admin","production_manager","sales"];
export const ROLES_CAN_EDIT = ["admin","production_manager","sales"];
export const ROLES_CAN_ADVANCE = ["admin","production_manager","production_staff","sales"];
export const ROLES_CAN_ADD_NOTES = ["admin","production_manager","sales","production_staff"];
export const ROLES_CAN_UPLOAD = ["admin","production_manager","sales","production_staff"];
export const ROLES_CAN_DELIVER = ["admin","production_manager","production_staff"];
export const ROLES_CAN_PAY = ["admin","production_manager","sales"];
export const ROLES_CAN_REPAIR = ["admin","production_manager"];
export const ROLES_CAN_REWORK = ["admin","production_manager"];
// Sales can only advance orders up to and including Deposit Paid
export const SALES_MAX_ADVANCE_TO = "Deposit Paid";
// Credit bypass: reseller + these payment terms can skip Deposit Paid
export const CREDIT_TERMS = ["30_day","60_day","custom"];
// Backward movement: source → target
export const REWORK_TARGETS = {"Material Check":"Quote Approved","Production":"Material Check","Quality Control":"Production"};
export const REWORK_REASONS = ["QC Failed","Client Change","Wrong Specs","Damaged Item","Repair / Rework","Material Issue","Other"];

export const ss = {
  input:{width:"100%",padding:"9px 12px",border:"1.5px solid #e0e0e0",borderRadius:"6px",fontSize:"14px",background:"#fafafa",outline:"none",boxSizing:"border-box"},
  sm:{width:"100%",padding:"6px 8px",border:"1px solid #e0e0e0",borderRadius:"4px",fontSize:"12px",background:"#fff",outline:"none",boxSizing:"border-box"},
  btn:{padding:"9px 20px",border:"none",borderRadius:"6px",fontSize:"13px",fontWeight:600,cursor:"pointer"},
  label:{display:"block",fontSize:"11px",fontWeight:600,color:"#888",marginBottom:"5px",textTransform:"uppercase",letterSpacing:"0.5px"},
};

export function getPayStatus(paid,total){if(!total||total<=0)return"Unpaid";if(paid<=0)return"Unpaid";if(paid>=total)return"Fully Paid";return(paid/total)<=0.35?"Deposit Paid":"Partially Paid"}
export function getStatusList(type){return type==="repair"||type==="return"?REPAIR_STATUSES:STATUSES}
export function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}


export const STATUS_BORDER_CLASS = {
  "Inquiry":"status-border-inquiry","Quote Approved":"status-border-quote",
  "Deposit Paid":"status-border-deposit","Material Check":"status-border-material",
  "Production":"status-border-production","Quality Control":"status-border-qc",
  "Ready for Delivery":"status-border-ready","Partially Delivered":"status-border-partial",
  "Delivered":"status-border-delivered","Closed":"status-border-closed",
  "Reported":"status-border-repair","Assessed":"status-border-material",
  "In Repair":"status-border-production","QC":"status-border-qc",
  "Redelivered":"status-border-ready",
};
