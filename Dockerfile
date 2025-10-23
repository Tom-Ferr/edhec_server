FROM node

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --legacy-peer-deps

COPY . .

CMD ["node", "app.js"]
