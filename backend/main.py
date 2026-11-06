import os
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field


# Expected structure:
# backend/
#   main.py
#   requirements.txt
#   model/
#     diabetes_model.pkl

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(
    os.getenv("MODEL_PATH", str(BASE_DIR / "model" / "diabetes_model.pkl"))
)

app = FastAPI(
    title="Diabetes Risk Prediction API",
    description=(
        "ML-based diabetes risk screening. This API does not provide "
        "a medical diagnosis."
    ),
    version="1.0.0",
)

# Set FRONTEND_ORIGINS to comma-separated origins when deploying.
# Example: https://username.github.io,http://localhost:5500
allowed_origins = [
    item.strip()
    for item in os.getenv("FRONTEND_ORIGINS", "*").split(",")
    if item.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class PatientInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    gender: Literal["Female", "Male", "Other"]
    age: float = Field(ge=0, le=120)
    hypertension: int = Field(ge=0, le=1)
    heart_disease: int = Field(ge=0, le=1)
    smoking_history: Literal[
        "No Info", "never", "current", "former", "ever", "not current"
    ]
    bmi: float = Field(gt=0, le=100)
    HbA1c_level: float = Field(gt=0, le=20)
    blood_glucose_level: float = Field(gt=0, le=600)


class PredictionResponse(BaseModel):
    prediction: int
    result: str
    probability: float
    probability_percent: float
    threshold: float
    model_name: str
    disclaimer: str


def load_model_artifact():
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Model file not found: {MODEL_PATH}. Put diabetes_model.pkl "
            "inside backend/model/ or configure MODEL_PATH."
        )

    artifact = joblib.load(MODEL_PATH)

    if not isinstance(artifact, dict) or "model" not in artifact:
        raise ValueError(
            "Invalid artifact: expected a dictionary containing the 'model' key."
        )

    threshold = float(artifact.get("threshold", 0.5))
    if not 0 <= threshold <= 1:
        raise ValueError("Saved threshold must be between 0 and 1.")

    return {
        "model": artifact["model"],
        "threshold": threshold,
        "model_name": artifact.get("model_name", "Gradient Boosting"),
        "features": artifact.get(
            "features",
            [
                "gender",
                "age",
                "hypertension",
                "heart_disease",
                "smoking_history",
                "bmi",
                "HbA1c_level",
                "blood_glucose_level",
            ],
        ),
    }


try:
    model_artifact = load_model_artifact()
    model_load_error = None
except Exception as exc:
    # Keep the API importable; /health and /predict will report model errors.
    model_artifact = None
    model_load_error = str(exc)


@app.get("/")
def root():
    return {
        "message": "Diabetes Risk Prediction API is running.",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
def health():
    if model_artifact is None:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "unhealthy",
                "model_loaded": False,
                "error": model_load_error,
            },
        )

    return {
        "status": "healthy",
        "model_loaded": True,
        "model_name": model_artifact["model_name"],
        "threshold": model_artifact["threshold"],
    }


@app.post("/predict", response_model=PredictionResponse)
def predict(patient: PatientInput):
    if model_artifact is None:
        raise HTTPException(
            status_code=503,
            detail=f"Model unavailable: {model_load_error}",
        )

    # The saved sklearn pipeline handles scaling and one-hot encoding.
    # Keep the original column names expected by the training pipeline.
    input_data = pd.DataFrame(
        [
            {
                "gender": patient.gender,
                "age": patient.age,
                "hypertension": patient.hypertension,
                "heart_disease": patient.heart_disease,
                "smoking_history": patient.smoking_history,
                "bmi": patient.bmi,
                "HbA1c_level": patient.HbA1c_level,
                "blood_glucose_level": patient.blood_glucose_level,
            }
        ],
        columns=model_artifact["features"],
    )

    try:
        probabilities = model_artifact["model"].predict_proba(input_data)
        positive_probability = float(probabilities[0][1])
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Prediction failed: {exc}",
        ) from exc

    threshold = model_artifact["threshold"]
    prediction = int(positive_probability >= threshold)

    return PredictionResponse(
        prediction=prediction,
        result="Diabetic" if prediction else "Non-Diabetic",
        probability=round(positive_probability, 6),
        probability_percent=round(positive_probability * 100, 2),
        threshold=threshold,
        model_name=model_artifact["model_name"],
        disclaimer=(
            "This is an ML-based risk-screening estimate, not a medical "
            "diagnosis. Consult a qualified healthcare professional."
        ),
    )
