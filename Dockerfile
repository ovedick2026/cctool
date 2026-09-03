FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

EXPOSE 7860

CMD ["npm", "start"]