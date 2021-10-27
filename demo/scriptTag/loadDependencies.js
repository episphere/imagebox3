// experimenting with satisfying dependencies ahead

const lala ={};

(async function(){
    console.log('loadDependencies.js loaded')
    async function asyncScript(url){
        let load = new Promise((resolve,regect)=>{
            let s = document.createElement('script')
            s.src=url
            s.onload=resolve
            document.head.appendChild(s)
        })
        await load
    }
    // satisfy dependencies
    await asyncScript('https://cdn.plot.ly/plotly-2.4.2.min.js')
    lala.Plotly=Plotly
    console.log("Plotly:",Plotly)
    await asyncScript('https://episphere.github.io/imageBox3/imageBox3.js')
})()