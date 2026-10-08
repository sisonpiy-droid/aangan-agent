# HubSpot: deal board, saved views and dashboard (click by click)

HubSpot's API can't create dashboards or saved views, so this part is manual, about 10 minutes. The data is
already there: every lead is a deal in the **AI Front Desk** pipeline with its fields, a Note (summary), a Call
(transcript) and a Task (next step) on the record.

> Free and Starter HubSpot limit how many dashboards and which chart types you get. If a chart type below is
> greyed out, use a **deal board / table view** instead; the numbers are the same.

## 1. The deal board

1. **CRM → Deals**. Open the pipeline dropdown at the top left and choose **AI Front Desk**.
2. Switch to **Board** view (the icon at the top right of the list). Columns are the stages:
   **Qualified · Needs review · Consultation booked · Declined**.
3. **Edit card** (top right of the board) and show: **Deal name, Amount, Qualification reason,
   Preferred consultation time, Consultation start**. Save.

## 2. Saved views (tabs above the deal list)

Create each with **Add view → Create new view**, set the filters, then **Save**.

| View name | Filters |
|---|---|
| **AI: qualified this week** | Pipeline = AI Front Desk · Deal stage = Qualified · Create date = This week |
| **AI: needs review** | Pipeline = AI Front Desk · Deal stage = Needs review |
| **AI: consultations booked** | Pipeline = AI Front Desk · Deal stage = Consultation booked |
| **AI: high priority** | Pipeline = AI Front Desk · Priority = High (these are the ₹30L+ leads) |

For tasks: **CRM → Tasks → Add view**: **AI: due today** = Status is Not started · Due date is today or earlier.
Every qualified lead creates "Send consultation link" due in 1 hour; existing-client complaints and dropped
calls create 15-minute call-back tasks; declined "later" leads create a re-contact task about 5 weeks out.

## 3. The dashboard

**Reporting → Dashboards → Create dashboard** → name it **AI Front Desk** → **Add report → Create new report**:

| Report | How |
|---|---|
| **Deals by stage** | Single-object report → Deals → Bar chart → X axis: Deal stage → filter Pipeline = AI Front Desk |
| **Qualified this week** | Single-object → Deals → KPI/number → filter Deal stage = Qualified, Create date = This week |
| **New enquiries per week** | Single-object → Deals → Column chart → X axis: Create date (weekly) → filter Pipeline = AI Front Desk |
| **Consultations booked** | Single-object → Deals → KPI → filter Deal stage = Consultation booked |
| **Qualified pipeline value** | Single-object → Deals → KPI → Sum of Amount → filter Deal stage = Qualified (amounts are only the budgets callers volunteered) |
| **Open tasks** | Single-object → Tasks → Table → filter Status = Not started, Due date = this week |

## What stays on our own dashboard (not in HubSpot)

HubSpot only knows about leads that reached it, so these live on the Aangan dashboard and the weekly Telegram digest:
decline reasons, failed HubSpot syncs (with the retry button), price/slot flags from the agent check, call
minutes and what the system costs to run.
