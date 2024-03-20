#!/bin/bash

for q in $(aws sqs list-queues --output text --no-paginate --query 'QueueUrls' --queue-name-prefix 'socket-io'); do
    if [ "$q" != "None" ]
    then
        echo "deleting queue $q";
        aws sqs delete-queue --queue-url $q;
    fi
done

for t in $(aws sns list-topics --output text --no-paginate --query 'Topics[].[TopicArn]' | grep 'socket-io'); do
    for s in $(aws sns list-subscriptions-by-topic --output text --no-paginate --query 'Subscriptions[].[SubscriptionArn]' --topic-arn $t); do
        echo "deleting subscription $s";
        aws sns unsubscribe --subscription-arn $s
    done

    echo "deleting topic $t";
    aws sns delete-topic --topic-arn $t
done
