jq -r 'select(.symbol == "TSLA" and .side == "sell") | .order_id' ./transaction-log.txt | xargs -I {} curl -s "https://example.com/api/{}" >> ./output.txt 

