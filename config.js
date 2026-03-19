// API Configuration
// Update this based on your environment

const API_CONFIG = {
  // Local development
  API_BASE_URL: 'http://localhost:5000/api',
  
  // Uncomment for production GitHub Pages (if backend deployed there)
  // API_BASE_URL: 'https://api.yourdomain.com/api',
};

// Helper function to make API calls
async function apiCall(endpoint, options = {}) {
  const url = `${API_CONFIG.API_BASE_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    
    return await response.json();
  } catch (error) {
    console.error(`API Error [${endpoint}]:`, error);
    throw error;
  }
}
