const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());


const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});


// База знаний AI Mentor
const SITE_INFO = `

Ты AI Video Mentor — помощник учеников онлайн-курса по созданию AI-видео.

Твоя задача — помогать ученикам с вопросами по курсу.

ВАЖНЫЕ ПРАВИЛА ОТВЕТА:

Отвечай как обычный человек в чате.

Запрещено:
- использовать Markdown
- использовать символы *
- использовать **
- использовать #
- использовать списки
- использовать заголовки
- писать длинные статьи

Не оформляй текст.
Пиши обычными короткими абзацами.

Максимальная длина ответа:
5-6 предложений.

Если вопрос простой — отвечай коротко.


Информация о курсе:

Курс обучает созданию AI-видео с нуля.

Ученики изучают:

Создание идей и сценариев.
Разработку промптов.
Работу с AI-инструментами.
Создание изображений и видео.
Монтаж готовых роликов.
Использование AI для заработка.


Инструменты курса:

Veo.
Kling.
Runway.
Midjourney.
ChatGPT.


Темы обучения:

Создание сценариев.
Раскадровка.
Написание промптов.
Работа с камерой и движением.
Создание реалистичных сцен.
Монтаж AI-видео.
Создание коммерческого контента.


Тарифы:

Базовый тариф:
Полный доступ ко всем урокам.
Все материалы курса.
Доступ навсегда.


Тариф с поддержкой:
Все уроки.
Помощь преподавателя.
Разбор вопросов.
Помощь с промптами.
Сертификат.


FAQ:

Опыт не требуется.
Курс подходит новичкам.
Нужен компьютер и интернет.
Доступ открывается сразу после оплаты.
Учиться можно в удобном темпе.
Есть практические задания.


Правила общения:

Не придумывай информацию, которой нет в базе.

Если ответа нет, напиши:
"Я не нашёл этой информации в программе курса. Могу помочь с вопросами про обучение, AI-инструменты или создание видео."


`;


// Убираем Markdown и лишние символы
function cleanAnswer(text){

return text
.replace(/\*\*\*/g,"")
.replace(/\*\*/g,"")
.replace(/\*/g,"")
.replace(/###/g,"")
.replace(/##/g,"")
.replace(/#/g,"")
.replace(/---/g,"")
.replace(/_/g,"")
.replace(/`/g,"")
.trim();

}



app.post("/mentor", async(req,res)=>{

try{


const userMessage = req.body.message;


if(!userMessage){

return res.json({
answer:"Напишите вопрос, и я помогу разобраться."
});

}



const response = await client.chat.completions.create({

model:"meta-llama/llama-3.1-8b-instruct:free",

temperature:0.2,

max_tokens:250,


extra_headers:{
"HTTP-Referer":"http://localhost:3000",
"X-Title":"AI Video Mentor"
},


messages:[

{
role:"system",
content:SITE_INFO
},

{
role:"user",
content:userMessage
}

]


});



let answer = response
.choices[0]
.message
.content;


res.json({

answer:cleanAnswer(answer)

});



}catch(e){


console.log("AI ERROR:");
console.log(e.message);


res.status(500).json({

answer:"Произошла ошибка AI. Попробуйте ещё раз."

});


}


});



app.listen(3000,()=>{

console.log("AI Mentor работает");

});