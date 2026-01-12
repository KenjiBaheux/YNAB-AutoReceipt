# YNAB Receipt Porter 🧾

Extract receipts with built-in browser AI and sync them to YNAB effortlessly.

## Overview
YNAB Receipt Porter is an experimental web application designed to automate the process of turning physical (or digital) receipt images into YNAB transactions. The prompt is tuned for **Japanese** receipts.

It leverages **Built-in AI (Prompt API)** to parse receipt data locally in your browser, ensuring privacy and no external API costs.

## Features
- **Built-in AI Extraction**: Automatically extracts Merchant, Date, Amount, and Category candidates directly in your browser.
- **Automated YNAB Setup**: Enter your Personal Access Token (PAT) and let the app discover your budgets and accounts for you.
- **Image Preprocessing**: Automatically crops white space and optimizes images for AI consumption.
- **Interactive Refinement**: 
  - **Manual Cropping**: Decide precisely what you want the AI to see.
  - **Redaction Tool**: Hide unnecessary information before processing to increase accuracy.
  - **Retry AI**: Re-run analysis after making image adjustments.
- **Bulk Sync**: Process a whole folder of receipts and push them to YNAB in one go.

## Disclaimer ⚠️
**This project is an exploration and is largely "vibe coded".** 
- It is provided "as is" with no guarantees of accuracy, reliability, or future compatibility.
- Use at your own risk. **Always verify** extracted data before pushing to your budget.
- This relies on experimental browser APIs which may change or be removed at any time.

## Requirements
- A browser with the **Prompt API** enabled (e.g., Chrome Canary or Dev with relevant flags).
- A valid **YNAB Personal Access Token**.

## How to use
1. Enter your **YNAB PAT**.
2. Select the **Budget** and **Account** you want to sync to.
3. Use the **Connect Receipt Folder** button to pick a local folder containing your receipt images (JPG, PNG; Not supported: PDF).
4. Wait for the AI to process the receipts. 
5. Review the extracted data on the cards, edit if necessary.
6. Click **Push to YNAB** or **Push All** to sync.
