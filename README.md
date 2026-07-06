# 🌍 Geo Secure: Spatio-Temporal AI for Disaster Prediction & Response

Geo Secure is an AI-driven resilience framework that transforms disaster management from **reactive** to **proactive**.  
It integrates **72-hour lead-time forecasting**, **real-time emergency coordination**, and **optimized recovery planning** into a single platform.

---

## 🚀 Features

### 1. Proactive Prediction Engine (Pre-Disaster)
- Hybrid **ConvLSTM + Attention** models for flood and earthquake forecasting.
- Data sources:
  - **Open-Meteo** → 10-year historical weather trends + real-time feeds.
  - **USGS Earthquake Catalog** → seismic monitoring and live event triggers.
- 72-hour high-accuracy alerts with dynamic weighting for seismic events.

### 2. Digital Lifeline (Response)
- **Edge AI** with TensorFlow Lite for on-device intelligence.
- **Low-byte SOS protocol** → works even on failing 2G networks.
- **Device-to-device mesh networking** → phones communicate via Bluetooth/Wi-Fi Direct when towers fail.
- **Hazard-aware offline routing** → cached maps + risk-based pathfinding.

### 3. Optimized Recovery & Logistics (Post-Disaster)
- **NSGA-II algorithm** for safe evacuation routing.
- **GIS spatial analysis** for shelter allocation and accessibility.
- **Digital damage records** → instant insurance and aid processing.

---

## 📚 Dataset Used

Geo Secure leverages **multi-source datasets** for robust disaster prediction:

- **Weather Data (Open-Meteo API)**  
  - Historical rainfall and temperature trends (10+ years).  
  - Real-time weather feeds for flood risk prediction.  

- **Seismic Data (USGS Earthquake Catalog)**  
  - Historical seismic activity records.  
  - Live API integration for magnitude ≥ 5 events within 500 km radius.  

- **Geospatial Data (GIS Layers)**  
  - Population density maps.  
  - Flood-prone zones and shelter locations.  

---

##  Usage
python src/api.py
